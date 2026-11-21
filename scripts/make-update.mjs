import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash,sign,createPublicKey} from 'node:crypto';
const {version}=JSON.parse(readFileSync('package.json','utf8'));
const {repository}=JSON.parse(readFileSync('resources/update-config.json','utf8'));
const privateKey=readFileSync(process.env.NEARLINK_SIGNING_KEY_FILE||'.release/update-private.pem');
const publicKey=readFileSync('resources/update-public.pem','utf8');
if(createPublicKey(privateKey).export({type:'spki',format:'pem'})!==publicKey)throw Error('Release key does not match bundled update publisher key');
const artifacts={};
for(const [key,suffix,format] of [['darwin-arm64','mac-arm64.zip','zip'],['darwin-x64','mac-x64.zip','zip'],['win32-x64','win-x64.exe','nsis']]){
 const name=`NearLink-${version}-${suffix}`,file=`outputs/installers/${name}`;
 if(!existsSync(file))throw Error(`Missing ${file}; build all three targets before publishing`);
 const bytes=readFileSync(file);
 artifacts[key]={url:`https://github.com/${repository}/releases/download/v${version}/${name}`,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,format};
}
const payload=Buffer.from(JSON.stringify({version,notes:process.env.NEARLINK_RELEASE_NOTES||readFileSync('outputs/发布说明.txt','utf8'),artifacts}));
writeFileSync('outputs/nearlink-update.json',JSON.stringify({payload:payload.toString('base64'),signature:sign(null,payload,privateKey).toString('base64')},null,2)+'\n');
console.log(`Signed update manifest for ${version}; private key was not included.`);
