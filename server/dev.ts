import 'dotenv/config';
import {app} from './app';
app.listen(Number(process.env.PORT||3001),'127.0.0.1',()=>console.info('Pulse Lab API em http://127.0.0.1:3001 — simulação; IA real bloqueada'));
