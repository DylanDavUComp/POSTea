require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const sharp = require('sharp');
if (process.env.NODE_ENV === 'production') throw new Error('Prueba reservada a desarrollo.');
const app = require('../src/app');
const { pool } = require('../src/db');
const { participation, schedule } = require('../src/config');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const suffix = crypto.randomBytes(8).toString('hex');
const programs=[], items=[];
let user;
const get = (path, options={}) => fetch(base+path,{redirect:'manual',...options});
const count = async () => (await pool.query('SELECT count(*)::int AS n FROM visitas WHERE investigacion_id=$1',[items[0].id])).rows[0].n;

let savedConfig=[];
async function main() {
  // Escenario fijo: exhibición futura, sin importar lo que haya en la base local (p. ej. demo:exhibicion).
  savedConfig=(await pool.query('SELECT clave,valor FROM configuracion')).rows;
  await pool.query(`UPDATE configuracion SET valor=CASE clave WHEN 'fecha_exhibicion_inicio' THEN '"2099-10-27"'::jsonb
    ELSE '"2099-10-30T23:59:00-05:00"'::jsonb END WHERE clave IN ('fecha_exhibicion_inicio','fecha_exhibicion_fin')`);
  const faculties=(await pool.query('SELECT id FROM facultades ORDER BY id LIMIT 2')).rows;
  const territories=(await pool.query('SELECT id FROM territorios ORDER BY id LIMIT 2')).rows;
  for (const faculty of faculties) programs.push((await pool.query('INSERT INTO programas(nombre,facultad_id) VALUES($1,$2) RETURNING id',[`DEMO fase5 ${suffix} ${faculty.id}`,faculty.id])).rows[0].id);
  const password=crypto.randomBytes(24).toString('hex');
  user=(await pool.query(`INSERT INTO usuarios(nombre,email,password_hash,rol,estado,tipo_persona,programa_id,acepta_datos_at,acepta_datos_version)
    VALUES('DEMO fase5',$1,$2,'autor','activo','docente',$3,now(),'prueba') RETURNING id,email`,[`fase5-${suffix}@example.com`,await bcrypt.hash(password,10),programs[0]])).rows[0];
  const image=await sharp({create:{width:30,height:20,channels:3,background:'#2a1150'}}).webp().toBuffer();
  for (let n=0;n<9;n++) {
    const state=n<5?'publicada':['borrador','enviada','seleccionada','archivada'][n-5];
    const item=(await pool.query(`INSERT INTO investigaciones(slug,programa_id,territorio_id,autor_id,titulo,pregunta_gancho,descripcion,objetivo,metodologia,resultados,
      estado_investigacion,tipo,imagen,imagen_mime,estado_flujo,publicada_at)
      VALUES($1,$2,$3,$4,$5,'Pregunta DEMO','<script>alert(1)</script>','Objetivo DEMO','Método DEMO','Resultado DEMO',$6,'investigacion',$7,'image/webp',$8,$9) RETURNING id,slug`,
    [`fase5-${suffix}-${n}`,programs[n===1?1:0],territories[n===4?1:0].id,user.id,`DEMO ${suffix} ficha ${n}`,n===1?'terminada':'en_desarrollo',image,state,state==='publicada'?new Date():null])).rows[0];
    items.push(item);
    await pool.query('INSERT INTO investigadores(investigacion_id,nombre_completo) VALUES($1,$2)',[item.id,`Investigador ${suffix}`]);
  }
  // Mensajes amables según fecha y flags (regla 9), con fechas fijas para no depender del día de la prueba.
  const cfg={fecha_apertura:'2026-10-05',fecha_cierre:'2026-10-19T23:59:00-05:00',fecha_exhibicion_inicio:'2026-10-27',
    fecha_exhibicion_fin:'2026-10-30T23:59:00-05:00',inversion_activa:true,comentarios_activos:false};
  assert.equal(participation(cfg,'inversion_activa','La inversión',new Date('2026-10-01T12:00:00-05:00')).message,'La inversión se activa el 27 de octubre.');
  assert.equal(participation(cfg,'inversion_activa','La inversión',new Date('2026-10-27T00:00:00-05:00')).open,true);
  assert.equal(participation(cfg,'inversion_activa','La inversión',new Date('2026-10-31T00:00:00-05:00')).open,false);
  assert.equal(participation(cfg,'comentarios_activos','Comentar',new Date('2026-10-28T10:00:00-05:00')).open,false);
  const steps=schedule(cfg,new Date('2026-10-22T10:00:00-05:00')).milestones;
  assert.deepEqual(steps.map(m=>m.label),['5 de octubre','19 de octubre','20 al 26 de octubre','27 al 30 de octubre']);
  assert.deepEqual(steps.map(m=>m.current),[false,false,true,false]);
  const home=await get('/'); assert.equal(home.status,200);
  const homeHtml=await home.text(); assert.match(homeHtml,/Cronograma/); assert.match(homeHtml,/Producción/); assert.match(homeHtml,/href="\/muro"/);
  assert.match(homeHtml,/Investigaciones publicadas/,'la portada muestra lo ya publicado');
  assert.ok(homeHtml.includes(`/f/${items[4].slug}`),'la publicación más reciente aparece en la portada');
  assert.ok(!items.slice(5).some(i=>homeHtml.includes(`/f/${i.slug}`)),'la portada no muestra fichas sin publicar');
  const css=await get('/css/catalogos.css'); assert.match(css.headers.get('content-type'),/text\/css/);
  const territoryColor=(await pool.query('SELECT color_hex FROM territorios WHERE id=$1',[territories[0].id])).rows[0].color_hex;
  assert.ok((await css.text()).includes(`.ter-${territories[0].id}{--ter:${territoryColor}}`),'colores de territorio desde la base');
  const wall=await get('/muro?q='+suffix); assert.equal(wall.status,200);
  const html=await wall.text();
  for (let n=0;n<9;n++) assert.equal(html.includes(`/f/${items[n].slug}`),n<5,'solo publicadas en el muro');
  const filterTests=[['facultad',faculties[1].id,[1]],['programa',programs[1],[1]],['territorio',territories[1].id,[4]],['estado','terminada',[1]]];
  for (const [key,value,expected] of filterTests) {
    const filtered=await (await get(`/muro?q=${suffix}&${key}=${value}`)).text();
    for(let n=0;n<5;n++) assert.equal(filtered.includes(`/f/${items[n].slug}`),expected.includes(n),key);
  }
  assert.match(await (await get('/muro?q='+encodeURIComponent(`Investigador ${suffix}`))).text(),new RegExp(items[0].slug));
  assert.match(await (await get('/muro?q=ausente-'+suffix)).text(),/Aún no hay ideas aquí/);
  assert.equal((await get('/muro?facultad=999999999999999999999999&programa[]=1&q[]=x')).status,200);
  for (const item of items.slice(5)) assert.equal((await get('/f/'+item.slug)).status,404);
  assert.equal((await get('/f/inexistente-'+suffix)).status,404);
  const path='/f/'+items[0].slug;
  assert.equal((await get(path,{method:'HEAD'})).status,200);
  await (await get(path,{headers:{purpose:'prefetch'}})).text();
  assert.equal(await count(),0,'HEAD y prefetch no cuentan');
  const opened=await get(path+'?src=qr'); assert.equal(opened.status,200);
  const fiche=await opened.text();
  assert.match(fiche,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(fiche,/Investigador/); assert.match(fiche,/Metodología/); assert.match(fiche,/Invierte en esta idea/); assert.match(fiche,/Deja tu comentario/);
  assert.ok(fiche.indexOf(`/f/${items[1].slug}`)<fiche.indexOf(`/f/${items[2].slug}`),'distinta facultad primero');
  assert.equal(fiche.includes(`/f/${items[4].slug}`),false,'Conecta usa el mismo territorio');
  assert.ok(fiche.includes(`/registro?next=${encodeURIComponent(path+'#invierte')}`),'registro vuelve a la ficha');
  assert.ok(fiche.includes(`/ingresar?next=${encodeURIComponent(path+'#comenta')}`),'ingreso vuelve a la ficha');
  assert.match(fiche,/class="territory-tag"/);
  await Promise.all(Array.from({length:5},async()=>{const r=await get(path);assert.equal(r.status,200);await r.text();}));
  assert.equal(await count(),1,'recargas concurrentes no duplican');
  assert.equal((await pool.query('SELECT origen FROM visitas WHERE investigacion_id=$1',[items[0].id])).rows[0].origen,'qr');
  await pool.query("UPDATE visitas SET created_at=now()-interval '31 minutes' WHERE investigacion_id=$1",[items[0].id]);
  await (await get(path)).text(); assert.equal(await count(),2,'tras 30 minutos cuenta otra visita');
  // Dos agentes autenticados de la misma cuenta comparten la ventana de deduplicación.
  const loginPage=await get('/ingresar'); let cookie=loginPage.headers.get('set-cookie').split(';')[0];
  const csrf=(await loginPage.text()).match(/name="_csrf" value="([a-f0-9]+)"/)[1];
  const login=await get('/ingresar',{method:'POST',headers:{cookie},body:new URLSearchParams({_csrf:csrf,email:user.email,password,next:path+'#invierte'})});
  assert.equal(login.status,302); assert.equal(login.headers.get('location'),path+'#invierte','vuelve al bloque de la ficha'); cookie=login.headers.get('set-cookie').split(';')[0]; await login.text();
  for(const agent of ['dispositivo-a','dispositivo-b']) await (await get(path,{headers:{cookie,'user-agent':agent}})).text();
  assert.equal(await count(),3,'un usuario autenticado no duplica entre dispositivos');
  const records=(await pool.query('SELECT user_agent_hash FROM visitas WHERE investigacion_id=$1',[items[0].id])).rows;
  assert.ok(records.every(r=>/^[a-f0-9]{64}$/.test(r.user_agent_hash)),'no almacena IP ni agente en claro');
  await pool.query("UPDATE investigaciones SET estado_flujo='archivada' WHERE id=$1",[items[0].id]);
  assert.equal((await get(path)).status,404);
  assert.equal((await get('/media/investigaciones/'+items[0].id)).status,404);
  assert.equal((await (await get('/muro?q='+suffix)).text()).includes(`/f/${items[0].slug}`),false);
  assert.equal(await count(),3,'una ficha archivada no registra visitas');
  console.log('Fase 5 OK: muro, filtros, búsqueda, privacidad, ficha, relacionados, HTML seguro, visitas QR/web y deduplicación concurrente de 30 minutos.');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  try {
    for (const row of savedConfig) await pool.query('UPDATE configuracion SET valor=$2 WHERE clave=$1',[row.clave,JSON.stringify(row.valor)]);
    await pool.query('DELETE FROM visitas WHERE investigacion_id=ANY($1::bigint[])',[items.map(i=>i.id)]);
    await pool.query('DELETE FROM investigaciones WHERE id=ANY($1::bigint[])',[items.map(i=>i.id)]);
    if(user) {
      await pool.query("DELETE FROM sesiones WHERE sess->>'userId'=$1",[String(user.id)]);
      await pool.query('DELETE FROM usuarios WHERE id=$1',[user.id]);
    }
    await pool.query('DELETE FROM programas WHERE id=ANY($1::bigint[])',[programs]);
  } finally {await new Promise(resolve=>server.close(resolve));await pool.end();}
});
