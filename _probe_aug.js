const lcu = require('./main/lcu');
const https = require('https');
(async () => {
  const c = await lcu.getLCU();
  console.log('conn', c && c[0] && c[0].port, c && c[0] && String(c[0].password).slice(0,6)+'...');
  if (!c || !c[0]) return;
  const { port } = c[0]; const password = c[0].token || c[0].password;
  const paths = ['/lol-game-data/assets/v1/cherry-augments.json'];
  for (const p of paths) {
    await new Promise(resolve => {
      const req = https.get({ host: '127.0.0.1', port, path: p, rejectUnauthorized: false,
        headers: { Authorization: 'Basic ' + Buffer.from('riot:' + password).toString('base64') } }, res => {
        let b=''; res.on('data', x=>b+=x); res.on('end', ()=>{
          console.log(p, res.statusCode, b.length);
          if (res.statusCode === 200) {
            try { const a=JSON.parse(b); console.log('n',a.length,'keys',Object.keys(a[0]||{}).join(','));
              const w=a.filter(x=>x.descTRA||x.description||x.summaryDescription||x.tooltipTRA);
              console.log('with desc',w.length);
              if(w[0]) console.log(JSON.stringify(w[0]).slice(0,500));
              require('fs').writeFileSync('D:/poro-build/smoke1653-lcu-aug.json', b);
            } catch(e){ console.log('parse fail', e.message); }
          }
          resolve();
        });
      });
      req.on('error', e => { console.log('ERR', e.message); resolve(); });
      req.setTimeout(8000, ()=>{ req.destroy(); resolve(); });
    });
  }
})();
