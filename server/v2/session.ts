import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {deflateRawSync,inflateRawSync} from 'node:zlib';
import {sessionSchema,type Session} from '../../shared/v2/contracts.js';
const aad=Buffer.from('pulse-ai-lab:simulated-session:v2');
const derive=(secret:string)=>createHash('sha256').update(aad).update(secret).digest();
export function encodeSession(session:Session,secret:string){
 if(!secret)throw new Error('PROVIDER_NOT_CONFIGURED');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',derive(secret),iv);cipher.setAAD(aad);
 const payload=Buffer.concat([cipher.update(deflateRawSync(Buffer.from(JSON.stringify(sessionSchema.parse(session))))),cipher.final()]);
 const token=Buffer.concat([iv,cipher.getAuthTag(),payload]).toString('base64url');if(token.length>100000)throw new Error('SESSION_FULL');return token;
}
export function decodeSession(token:string,secret:string):Session{
 try{if(token.length>100000)throw new Error();const input=Buffer.from(token,'base64url');if(input.length<29)throw new Error();const decipher=createDecipheriv('aes-256-gcm',derive(secret),input.subarray(0,12));decipher.setAAD(aad);decipher.setAuthTag(input.subarray(12,28));const compressed=Buffer.concat([decipher.update(input.subarray(28)),decipher.final()]);const session=sessionSchema.parse(JSON.parse(inflateRawSync(compressed,{maxOutputLength:1000000}).toString()));if(session.expiresAt<Date.now())throw new Error();return session;}catch{throw new Error('INVALID_SESSION');}
}
