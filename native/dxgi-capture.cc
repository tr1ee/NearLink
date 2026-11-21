#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <cstring>
#include <memory>
#include "win_napi_bridge.h"
#include "common.h"
#include "windows-service-frame.h"

using Microsoft::WRL::ComPtr;

namespace {
constexpr UINT Width = 1920;
constexpr UINT Height = 1080;
constexpr size_t RowBytes = Width * 4;

struct Capture {
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<IDXGIOutputDuplication> duplication;
  ComPtr<ID3D11Texture2D> staging;
  RECT desktop{};
  bool separatePointer = false;
  HDC canvas = nullptr;
  HBITMAP bitmap = nullptr;
  HGDIOBJ original = nullptr;
  void* pixels = nullptr;

  ~Capture() {
    if (original && original != HGDI_ERROR) SelectObject(canvas, original);
    if (bitmap) DeleteObject(bitmap);
    if (canvas) DeleteDC(canvas);
  }

  bool open(const POINT target) {
    ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return false;
    for (UINT a = 0; ; a++) {
      ComPtr<IDXGIAdapter1> adapter;
      if (factory->EnumAdapters1(a, &adapter) != S_OK) return false;
      for (UINT o = 0; ; o++) {
        ComPtr<IDXGIOutput> output;
        if (adapter->EnumOutputs(o, &output) != S_OK) break;
        DXGI_OUTPUT_DESC desc{};
        if (FAILED(output->GetDesc(&desc)) || !desc.AttachedToDesktop ||
            !PtInRect(&desc.DesktopCoordinates, target)) continue;
        desktop = desc.DesktopCoordinates;
        if (desktop.right - desktop.left != Width || desktop.bottom - desktop.top != Height ||
            desc.Rotation != DXGI_MODE_ROTATION_IDENTITY) return false;
        ComPtr<ID3D11Device> device;
        ComPtr<IDXGIOutput1> output1;
        if (FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
                &device, nullptr, &context)) || FAILED(output.As(&output1)) ||
            FAILED(output1->DuplicateOutput(device.Get(), &duplication))) return false;
        D3D11_TEXTURE2D_DESC texture{};
        texture.Width = Width;
        texture.Height = Height;
        texture.MipLevels = texture.ArraySize = 1;
        texture.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        texture.SampleDesc.Count = 1;
        texture.Usage = D3D11_USAGE_STAGING;
        texture.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        if (FAILED(device->CreateTexture2D(&texture, nullptr, &staging))) return false;
        BITMAPINFO info{};
        info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        info.bmiHeader.biWidth = Width;
        info.bmiHeader.biHeight = -LONG(Height);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        canvas = CreateCompatibleDC(nullptr);
        if (!canvas) return false;
        bitmap = CreateDIBSection(canvas, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
        if (!bitmap) return false;
        original = SelectObject(canvas, bitmap);
        return original && original != HGDI_ERROR;
      }
    }
  }

  void drawPointer() const {
    CURSORINFO cursor{sizeof(CURSORINFO)};
    if (!GetCursorInfo(&cursor) || !(cursor.flags & CURSOR_SHOWING)) return;
    ICONINFO shape{};
    if (!GetIconInfo(cursor.hCursor, &shape)) return;
    DrawIconEx(canvas, cursor.ptScreenPos.x - desktop.left - LONG(shape.xHotspot),
        cursor.ptScreenPos.y - desktop.top - LONG(shape.yHotspot), cursor.hCursor,
        0, 0, 0, nullptr, DI_NORMAL);
    if (shape.hbmMask) DeleteObject(shape.hbmMask);
    if (shape.hbmColor) DeleteObject(shape.hbmColor);
    GdiFlush();
  }

  napi_value frame(napi_env env) {
    DXGI_OUTDUPL_FRAME_INFO info{};
    ComPtr<IDXGIResource> resource;
    HRESULT hr = duplication->AcquireNextFrame(6, &info, &resource);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) return Undefined(env);
    if (FAILED(hr)) return error(env, "DXGI capture lost its display");
    struct FrameLease {
      IDXGIOutputDuplication* source;
      ~FrameLease() { source->ReleaseFrame(); }
    } lease{duplication.Get()};
    if (info.LastMouseUpdateTime.QuadPart) separatePointer = !!info.PointerPosition.Visible;
    ComPtr<ID3D11Texture2D> image;
    if (FAILED(resource.As(&image))) return error(env, "DXGI returned an invalid texture");
    D3D11_TEXTURE2D_DESC actual{};
    image->GetDesc(&actual);
    if (actual.Width != Width || actual.Height != Height || actual.Format != DXGI_FORMAT_B8G8R8A8_UNORM)
      return error(env, "DXGI display format changed");
    context->CopyResource(staging.Get(), image.Get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped)))
      return error(env, "DXGI texture readback failed");
    void* bytes = nullptr;
    napi_value buffer;
    const auto status = napi_create_arraybuffer(env, RowBytes * Height, &bytes, &buffer);
    if (status == napi_ok) {
      auto destination = static_cast<unsigned char*>(separatePointer ? pixels : bytes);
      const auto source = static_cast<const unsigned char*>(mapped.pData);
      for (UINT row = 0; row < Height; row++)
        std::memcpy(destination + row * RowBytes, source + row * mapped.RowPitch, RowBytes);
    }
    context->Unmap(staging.Get(), 0);
    if (status != napi_ok) return error(env, "DXGI frame allocation failed");
    if (separatePointer) {
      drawPointer();
      std::memcpy(bytes, pixels, RowBytes * Height);
    }
    return buffer;
  }

  static napi_value error(napi_env env, const char* text) {
    napi_throw_error(env, nullptr, text);
    return nullptr;
  }
};

std::unique_ptr<Capture> capture;
napi_value Open(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value data[1];
  napi_get_cb_info(env, info, &argc, data, nullptr, nullptr);
  if (!argc) return JSBool(env, false);
  capture.reset();
  auto next = std::make_unique<Capture>();
  if (!next->open({LONG(Num(env, data[0], "x")), LONG(Num(env, data[0], "y"))}))
    return JSBool(env, false);
  capture = std::move(next);
  return JSBool(env, true);
}
napi_value Read(napi_env env, napi_callback_info) {
  return capture ? capture->frame(env) : Undefined(env);
}
napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"open", nullptr, Open, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openService",nullptr,OpenServiceFrame,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"readService",nullptr,ReadServiceFrame,nullptr,nullptr,nullptr,napi_default,nullptr},
  };
  napi_define_properties(env, exports, ARRAYSIZE(properties), properties);
  napi_add_env_cleanup_hook(env, [](void*) { capture.reset();serviceFrame.reset(); }, nullptr);
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
