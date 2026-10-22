import {build} from 'esbuild';
// Checked-in generated entrypoint avoids the earlier Vercel ESM import failure.
// All repo imports are bundled; only Node builtins and installed packages remain.
await build({entryPoints:['server/v2/handler.ts'],outfile:'api/conversation.js',bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',legalComments:'none'});
// Webhook do WhatsApp (Z-API): mesma estratégia, outro ponto de entrada.
await build({entryPoints:['server/whatsapp/handler.ts'],outfile:'api/whatsapp.js',bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',legalComments:'none'});
// Código de login do dashboard entregue pelo WhatsApp (Send SMS Hook do Supabase).
await build({entryPoints:['server/whatsapp/smsHook.ts'],outfile:'api/auth-sms-hook.js',bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',legalComments:'none'});
