// Standalone Windows diagnostic, never linked into the application. Creates a
// capture item only: no capture session, frames, input, network or file output.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <windows.graphics.capture.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <cstdio>
#include <vector>

static void printIntegrity() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return;
  DWORD size = 0;
  GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &size);
  std::vector<BYTE> bytes(size);
  if (GetTokenInformation(token, TokenIntegrityLevel, bytes.data(), size, &size)) {
    auto sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(bytes.data())->Label.Sid;
    const auto count = *GetSidSubAuthorityCount(sid);
    if (count) std::printf("integrityRid=%lu\n", *GetSidSubAuthority(sid, count - 1));
  }
  CloseHandle(token);
}

int main() {
  printIntegrity();
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    auto factory = winrt::get_activation_factory<
        winrt::Windows::Graphics::Capture::GraphicsCaptureItem,
        IGraphicsCaptureItemInterop>();
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem item{nullptr};
    const HMONITOR monitor = MonitorFromPoint({0, 0}, MONITOR_DEFAULTTOPRIMARY);
    const HRESULT result = factory->CreateForMonitor(
        monitor,
        winrt::guid_of<winrt::Windows::Graphics::Capture::GraphicsCaptureItem>(),
        winrt::put_abi(item));
    std::printf("CreateForMonitor=0x%08lX\n", static_cast<unsigned long>(result));
    return FAILED(result) ? 1 : 0;
  } catch (const winrt::hresult_error& error) {
    std::printf("WinRT initialization=0x%08lX\n",
                static_cast<unsigned long>(error.code().value));
    return 1;
  }
}
