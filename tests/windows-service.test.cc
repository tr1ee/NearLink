#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "../native/windows-service-auth.h"
#include "../native/windows-desktop-epoch.h"
#include <cassert>
#include <fstream>
#include <sstream>
#include <cstdio>
#include <thread>
static void desktopEpochIsolation() {
  DesktopEpoch epoch;const auto ordinary=epoch.observe(L"Default");assert(ordinary&&epoch.matches(ordinary));
  // Input notices Winlogon before capture. An old queued click must already be
  // rejected; capture observing that same desktop must not advance it again.
  const auto secure=epoch.observe(L"Winlogon");assert(!epoch.matches(ordinary));
  assert(epoch.observe(L"Winlogon")==secure&&epoch.matches(secure));
  epoch.layoutChanged();assert(!epoch.matches(secure));const auto layout=epoch.current();
  assert(epoch.observe(L"Winlogon")==layout);
  std::vector<std::thread> observers;
  for(int i=0;i<8;++i)observers.emplace_back([&]{for(int n=0;n<100;++n)epoch.observe(L"Default");});
  for(auto& thread:observers)thread.join();assert(epoch.current()==layout+1);
  assert(!epoch.matches(layout)&&!epoch.matches(0));
}
int wmain(int argc,wchar_t** argv) {
  desktopEpochIsolation();
  using namespace desktopservice;
  Request request;request.sequence=1;request.operation=Operation::hello;strcpy_s(request.authority,"deadbeef");
  assert(valid(request,0));assert(!valid(request,1));
  request.operation=Operation(99);assert(!valid(request,0));
  FrameHeader frame;frame.width=1920;frame.height=1080;frame.bytes=1920*1080*4;frame.desktopEpoch=1;
  assert(frameValid(frame));frame.bytes--;assert(!frameValid(frame));frame.width=0xffffffff;assert(!frameValid(frame));
  assert(unhex("g0",64).empty());assert(unhex(std::string(130,'a'),64).empty());
  assert(!verifyProof("","",std::string(64,'a'),"test"));
  assert(argc==2);std::ifstream input(argv[1]);std::string cert,proof,peer;
  assert(std::getline(input,cert)&&std::getline(input,proof)&&std::getline(input,peer));
  std::ostringstream text;text<<input.rdbuf();auto challenge=text.str();
  assert(verifyProof(cert,proof,peer,challenge));
  // Pinning the whole certificate was previously accepted by a self-consistent
  // fixture but disagreed with NearLink's production SPKI device identity.
  assert(!verifyProof(cert,proof,digestBytes(unhex(cert,4096)),challenge));
  assert(!verifyProof(cert,proof,peer,challenge+"changed"));
  assert(!verifyProof(cert,proof,std::string(64,'0'),challenge));
  proof[0]=proof[0]=='a'?'b':'a';assert(!verifyProof(cert,proof,peer,challenge));
  puts("Service protocol bounds, frame bounds and Node-to-Windows CNG proof checks passed; no desktop input injected.");
}
