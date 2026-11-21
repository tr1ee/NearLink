#pragma once
#include "windows-service-wire.h"
#include <wincrypt.h>
#include <sstream>
namespace desktopservice {
inline std::string digestBytes(const std::vector<BYTE>& bytes) {
  BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;
  BYTE digest[32]{};std::string result;
  if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)==0&&
    BCryptCreateHash(algorithm,&hash,nullptr,0,nullptr,0,0)==0&&
    BCryptHashData(hash,const_cast<BYTE*>(bytes.data()),ULONG(bytes.size()),0)==0&&
    BCryptFinishHash(hash,digest,sizeof(digest),0)==0) {
    static const char hex[]="0123456789abcdef";for(BYTE b:digest){result+=hex[b>>4];result+=hex[b&15];}
  }
  if(hash)BCryptDestroyHash(hash);if(algorithm)BCryptCloseAlgorithmProvider(algorithm,0);return result;
}
inline bool verifyProof(const std::string& certificate,const std::string& proof,
                        const std::string& fingerprint,const std::string& challenge) {
  const auto der=unhex(certificate,4096),signature=unhex(proof,64);
  if(signature.size()!=64)return false;
  PCCERT_CONTEXT cert=CertCreateCertificateContext(X509_ASN_ENCODING,der.data(),DWORD(der.size()));
  if(!cert)return false;
  // IdentityStore pins SHA-256 of DER SubjectPublicKeyInfo, not of the entire
  // certificate. Re-encode that same SPKI structure before checking the pin.
  BYTE* spki=nullptr;DWORD spkiBytes=0;
  bool pinned=CryptEncodeObjectEx(X509_ASN_ENCODING,X509_PUBLIC_KEY_INFO,
    &cert->pCertInfo->SubjectPublicKeyInfo,CRYPT_ENCODE_ALLOC_FLAG,nullptr,&spki,&spkiBytes)!=FALSE;
  pinned=pinned&&digestBytes(std::vector<BYTE>(spki,spki+spkiBytes))==fingerprint;
  if(spki)LocalFree(spki);
  if(!pinned){CertFreeCertificateContext(cert);return false;}
  BCRYPT_KEY_HANDLE key=nullptr;
  bool valid=CryptImportPublicKeyInfoEx2(X509_ASN_ENCODING,&cert->pCertInfo->SubjectPublicKeyInfo,0,nullptr,&key)!=FALSE;
  CertFreeCertificateContext(cert);
  const auto digest=unhex(digestBytes(std::vector<BYTE>(challenge.begin(),challenge.end())),32);
  valid=valid&&digest.size()==32&&BCryptVerifySignature(key,nullptr,const_cast<BYTE*>(digest.data()),DWORD(digest.size()),
    const_cast<BYTE*>(signature.data()),DWORD(signature.size()),0)==0;
  if(key)BCryptDestroyKey(key);return valid;
}
inline std::string peerFromAuthority(const std::string& authority) {
  auto a=authority.find(':'),b=authority.find(':',a==std::string::npos?a:a+1);
  if(a==std::string::npos||b==std::string::npos||authority.find(':',b+1)!=std::string::npos)return {};
  auto peer=authority.substr(a+1,b-a-1);
  return inputsecurity::hexDigest(peer)?peer:"";
}
inline std::string challengeText(const std::string& host,const std::string& authority,
                                 DWORD session,const std::string& nonce,bool control=true) {
  return "NearLink desktop service v1\n"+host+"\n"+authority+"\n"+std::to_string(session)+"\n"+nonce+"\n"+(control?"control\n":"view\n");
}
}
