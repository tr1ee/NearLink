#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "../native/windows-service-auth.h"
#include <cassert>
#include <fstream>
#include <sstream>
#include <cstdio>
int wmain(int argc,wchar_t** argv) {
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
  assert(!verifyProof(cert,proof,peer,challenge+"changed"));
  assert(!verifyProof(cert,proof,std::string(64,'0'),challenge));
  proof[0]=proof[0]=='a'?'b':'a';assert(!verifyProof(cert,proof,peer,challenge));
  puts("Service protocol bounds, frame bounds and Node-to-Windows CNG proof checks passed; no desktop input injected.");
}
