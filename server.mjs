import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const uploadDir = path.join(dataDir, 'uploads');
const port = Number(process.env.PORT || 8080);
const storageBucket = process.env.STORAGE_BUCKET || '';
const accessKey = process.env.CAPTURE_ACCESS_KEY || '';
await fs.mkdir(uploadDir, { recursive: true });

const mime = {
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json',
  '.png':'image/png',
  '.svg':'image/svg+xml'
};

function json(res, status, body){
  res.writeHead(status, {'content-type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(body));
}

function safeName(name='capture'){
  return name.replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120);
}

async function bodyJson(req, limit=30*1024*1024){
  let size=0;
  const chunks=[];
  for await (const chunk of req){
    size += chunk.length;
    if(size > limit) throw new Error('Request too large. Try fewer or smaller images.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function authorized(req){
  return !accessKey || req.headers['x-smart-capturer-key'] === accessKey;
}

function parseDataUrl(dataUrl){
  if(typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if(!m) return null;
  try {
    return { contentType:m[1], buffer:Buffer.from(m[2], 'base64') };
  } catch {
    return null;
  }
}

function fallbackContext({kind,text='',filename=''}){
  const s=`${text} ${filename}`.toLowerCase();
  let category='Other';
  if(/receipt|invoice|oreilly|o'reilly|autozone|napa|costco|walmart|amazon/.test(s)) category='Receipt';
  else if(/recipe|ingredients|cook|bake|instagram|reel|food/.test(s)) category='Recipe';
  else if(/work|job|panel|plc|machine|wiring|controls/.test(s)) category='Work Photo';
  else if(/family|old photo|archive|grandma|grandpa/.test(s)) category='Old Photo / Archive';
  else if(/subaru|tacoma|f-?350|mach-?e|rsx|highlander|vehicle|car/.test(s)) category='Vehicle';
  return {
    category,
    title:filename ? filename.replace(/\.[^.]+$/,'') : (kind==='link'?'Captured link':'New capture'),
    context:text||'',
    tags:[],
    confidence:category==='Other'?.25:.55,
    destination_hint:category==='Recipe'?'Recipes / myApron':category==='Receipt'?'Receipts':category,
    extracted:{}
  };
}

async function analyzeWithOpenAI(payload){
  const content=[{
    type:'input_text',
    text:`Classify this item for a family capture manager. Return ONLY valid JSON with keys: category, title, context, tags (array), confidence (0-1), destination_hint, extracted (object). Categories should prefer Receipt, Recipe, Work Photo, Old Photo / Archive, Vehicle, Other. Infer useful context such as vehicle/project/vendor/date/amount/people/location when visible, but never invent facts. User-supplied text/link: ${payload.text||'(none)'}`
  }];
  if(payload.file?.dataUrl?.startsWith('data:image/')){
    content.push({type:'input_image',image_url:payload.file.dataUrl,detail:'auto'});
  }
  const r=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{'authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'content-type':'application/json'},
    body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5.6-luna',input:[{role:'user',content}]})
  });
  if(!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const out=await r.json();
  const raw=(out.output||[])
    .flatMap(x=>x.content||[])
    .filter(x=>x.type==='output_text')
    .map(x=>x.text)
    .join('\n')
    .trim()
    .replace(/^```json\s*/i,'')
    .replace(/```$/,'')
    .trim();
  return JSON.parse(raw);
}

let cachedToken={value:'',expires:0};
async function googleAccessToken(){
  if(cachedToken.value && cachedToken.expires>Date.now()+60000) return cachedToken.value;
  const r=await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{
    headers:{'Metadata-Flavor':'Google'}
  });
  if(!r.ok) throw new Error(`Could not obtain Cloud Run service account token (${r.status})`);
  const j=await r.json();
  cachedToken={value:j.access_token,expires:Date.now()+j.expires_in*1000};
  return cachedToken.value;
}

async function gcsUpload(objectName, buffer, contentType='application/octet-stream'){
  const token=await googleAccessToken();
  const u=`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(storageBucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const r=await fetch(u,{
    method:'POST',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':contentType},
    body:buffer
  });
  if(!r.ok) throw new Error(`Cloud Storage upload failed (${r.status}): ${await r.text()}`);
  return await r.json();
}

async function saveCapture(p){
  const now=new Date();
  const id=`${now.toISOString().replace(/[:.]/g,'-')}-${Math.random().toString(36).slice(2,8)}`;
  const incomingFiles=Array.isArray(p.files) ? p.files : [];
  const files=[];
  const record={id,created_at:now.toISOString(),files,...(p.metadata||{})};

  if(record.kind==='image' && incomingFiles.length===0){
    throw new Error('Image capture contained no image files.');
  }

  if(storageBucket){
    for(const f of incomingFiles){
      const parsed=parseDataUrl(f.dataUrl);
      if(!parsed) throw new Error(`Image data was missing or invalid for ${f.name||'capture'}.`);
      if(parsed.buffer.length===0) throw new Error(`Image ${f.name||'capture'} was empty.`);
      const fn=safeName(f.name||'capture.bin');
      const object=`captures/${id}/${fn}`;
      await gcsUpload(object, parsed.buffer, parsed.contentType);
      files.push({name:fn,object,content_type:parsed.contentType,bytes:parsed.buffer.length});
    }
    if(files.length!==incomingFiles.length) throw new Error('Not every selected image was persisted.');
    await gcsUpload(`captures/${id}/metadata.json`,Buffer.from(JSON.stringify(record,null,2)),'application/json');
    console.log(`Saved capture ${id}: ${files.length} file(s), ${files.reduce((n,f)=>n+f.bytes,0)} bytes to GCS`);
    return {
      ok:true,
      id,
      saved_files:files.map(x=>x.name),
      file_count:files.length,
      bytes_saved:files.reduce((n,f)=>n+f.bytes,0),
      storage:'google-cloud-storage',
      bucket:storageBucket,
      record
    };
  }

  const dir=path.join(uploadDir,id);
  await fs.mkdir(dir,{recursive:true});
  for(const f of incomingFiles){
    const parsed=parseDataUrl(f.dataUrl);
    if(!parsed) throw new Error(`Image data was missing or invalid for ${f.name||'capture'}.`);
    if(parsed.buffer.length===0) throw new Error(`Image ${f.name||'capture'} was empty.`);
    const fn=safeName(f.name||'capture.bin');
    await fs.writeFile(path.join(dir,fn),parsed.buffer);
    files.push({name:fn,content_type:parsed.contentType,bytes:parsed.buffer.length});
  }
  if(files.length!==incomingFiles.length) throw new Error('Not every selected image was persisted.');
  await fs.writeFile(path.join(dir,'metadata.json'),JSON.stringify(record,null,2));
  await fs.appendFile(path.join(dataDir,'index.ndjson'),JSON.stringify(record)+'\n');
  console.log(`Saved capture ${id}: ${files.length} file(s), ${files.reduce((n,f)=>n+f.bytes,0)} bytes locally`);
  return {
    ok:true,
    id,
    saved_files:files.map(x=>x.name),
    file_count:files.length,
    bytes_saved:files.reduce((n,f)=>n+f.bytes,0),
    storage:'local-development',
    record
  };
}

async function api(req,res,url){
  if(req.method==='GET' && url.pathname==='/api/health'){
    return json(res,200,{
      ok:true,
      app:'Smart Capturer',
      revision:1,
      auth_required:Boolean(accessKey),
      storage:storageBucket?'gcs':'local-development',
      ai:Boolean(process.env.OPENAI_API_KEY)
    });
  }
  if(!authorized(req)) return json(res,401,{error:'Family access code required'});

  if(req.method==='POST' && url.pathname==='/api/analyze'){
    const p=await bodyJson(req);
    const base=fallbackContext({kind:p.kind,text:p.text,filename:p.file?.name});
    if(!process.env.OPENAI_API_KEY) return json(res,200,{source:'local-fallback',...base});
    try {
      return json(res,200,{source:'openai',...(await analyzeWithOpenAI(p))});
    } catch(e){
      console.error(e);
      return json(res,200,{source:'fallback-after-error',warning:e.message,...base});
    }
  }

  if(req.method==='POST' && url.pathname==='/api/save'){
    return json(res,200,await saveCapture(await bodyJson(req)));
  }

  return json(res,404,{error:'Not found'});
}

async function serve(req,res,url){
  let rel=decodeURIComponent(url.pathname);
  if(rel==='/') rel='/index.html';
  const target=path.normalize(path.join(publicDir,rel));
  if(!target.startsWith(publicDir)){
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try{
    const b=await fs.readFile(target);
    res.writeHead(200,{
      'content-type':mime[path.extname(target)]||'application/octet-stream',
      'cache-control':rel==='/index.html'?'no-cache':'public, max-age=3600'
    });
    res.end(b);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(url.pathname.startsWith('/api/')) await api(req,res,url);
    else await serve(req,res,url);
  } catch(e){
    console.error(e);
    json(res,500,{error:e.message});
  }
});

server.listen(port,'0.0.0.0',()=>console.log(`Smart Capturer listening on ${port}`));
