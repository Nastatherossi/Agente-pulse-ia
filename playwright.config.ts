import {defineConfig} from '@playwright/test';
import chromium from '@sparticuz/chromium';
const browser=process.env.LAB_BUNDLED_CHROMIUM==='true'?{executablePath:process.env.LAB_CHROMIUM_PATH||await chromium.executablePath(),args:chromium.args}:{};
export default defineConfig({testDir:'tests/e2e',use:{baseURL:'http://127.0.0.1:5173',headless:true,launchOptions:browser},webServer:{command:'npm run dev',url:'http://127.0.0.1:5173',reuseExistingServer:true},projects:[{name:'desktop',use:{viewport:{width:1440,height:1000}}},{name:'mobile',use:{viewport:{width:390,height:844}}}]});
