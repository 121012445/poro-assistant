const lcu=require('./main/lcu'),https=require('https');
const paths=[
 '/lol-cherry/v1/augments','/lol-cherry/v1/augment/AugmentList','/lol-cherry/v1/augments/details',
 '/lol-game-data/assets/v1/cherry-augments-desc.json','/lol-game-data/assets/v1/cherry-augments-description.json',
 '/lol-game-data/assets/v1/cherry-augments-localized.json','/lol-game-data/assets/v1/cherry-augment-details.json',
 '/lol-game-data/assets/v1/cherry-augments-full.json','/lol-game-data/assets/v1/augments.json',
 '/lol-game-data/assets/config/gameData/cherry-augments.json'
];
(async()=>{const c=await lcu.getLCU();if(!c||!c[0])return;const {port}=c[0],auth='Basic '+Buffer.from('riot:'+(c[0].token||c[0].password)).toString('base64');
for(const p of paths){await new Promise(r=>{const q=https.get({host:'127.0.0.1',port,path:p,rejectUnauthorized:false,headers:{Authorization:auth}},res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>{console.log(res.statusCode,b.length,p, b.length&&res.statusCode===200?JSON.stringify(b).slice(0,120):'');r();});});q.on('error',e=>{r();});q.setTimeout(3000,()=>{q.destroy();r();});});}
})();
