import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnalyzer } from './ai.mjs';
import { createDriveStore } from './drive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const uploadDir = path.join(dataDir, 'uploads');
const port = Number(process.env.PORT || 8080);
const storageBucket = process.env.STORAGE_BUCKET || '';
const accessKey = process.env.CAPTURE_ACCESS_KEY || '';
const analyzer = createAnalyzer();
const personalDriveStore = createDriveStore();
const workDriveStore = createDriveStore({
  env: { ...process.env, DRIVE_FOLDER_ID: process.env.WORK_DRIVE_FOLDER_ID || '' }
});
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

function captureScope(value){
  return value === 'work' ? 'work' : 'personal';
}

function driveStoreFor(scope){
  return scope === 'work' ? workDriveStore : personalDriveStore;
}

function destinationFor(scope){
  return scope === 'work' ? 'Work / ToBeSorted' : 'Personal / ToBeSorted';
}

function validCaptureId(value){
  return typeof value === 'string' && /^[a-zA-Z0-9-]{10,120}$/.test(value);
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

async function gcsRead(objectName){
  const token=await googleAccessToken();
  const u=`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(storageBucket)}/o/${encodeURIComponent(objectName)}?alt=media`;
  const r=await fetch(u,{headers:{Authorization:`Bearer ${token}`}});
  if(r.status===404) return null;
  if(!r.ok) throw new Error(`Cloud Storage read failed (${r.status})`);
  return await r.json();
}

async function saveCapture(p){
  const now=new Date();
  const suppliedId=typeof p.capture_id==='string' ? p.capture_id : '';
  if(suppliedId && !validCaptureId(suppliedId)) throw new Error('Invalid capture ID.');
  const id=suppliedId||`${now.toISOString().replace(/[:.]/g,'-')}-${Math.random().toString(36).slice(2,8)}`;
  const scope=captureScope(p.scope);
  const driveStore=driveStoreFor(scope);
  const incomingFiles=Array.isArray(p.files) ? p.files : [];
  const metadataOnly=Boolean(p.metadata_only);
  const deferMetadata=Boolean(p.defer_metadata);
  const files=[];
  const record={
    id,
    created_at:now.toISOString(),
    scope,
    workflow_status:'to_be_sorted',
    recognition_status:analyzer.configured?'pending':'not_run',
    destination:destinationFor(scope),
    files,
    ...(p.metadata||{}),
    id,
    scope
  };

  if(record.kind==='image' && incomingFiles.length===0 && !metadataOnly){
    throw new Error('Image capture contained no image files.');
  }

  if(scope==='work' && personalDriveStore.configured && !workDriveStore.configured){
    throw new Error('The work ToBeSorted folder is not configured yet.');
  }

  if(driveStore.configured){
    const existingFiles=await driveStore.listCaptureFiles(id);
    const existingByName=new Map(existingFiles.map(file=>[file.name,file]));
    for(const [index,f] of incomingFiles.entries()){
      const parsed=parseDataUrl(f.dataUrl);
      if(!parsed) throw new Error(`Image data was missing or invalid for ${f.name||'capture'}.`);
      if(parsed.buffer.length===0) throw new Error(`Image ${f.name||'capture'} was empty.`);
      const fn=safeName(f.name||'capture.bin');
      const storedName=`${id}_${String(index+1).padStart(2,'0')}_${fn}`;
      const existing=existingByName.get(storedName);
      if(existing){
        files.push({name:storedName,drive_file_id:existing.id,content_type:existing.mimeType||parsed.contentType,bytes:Number(existing.size||parsed.buffer.length)});
        continue;
      }
      const saved=await driveStore.uploadFile({name:storedName,buffer:parsed.buffer,contentType:parsed.contentType,captureId:id,kind:record.kind,role:'content',scope});
      files.push({name:storedName,drive_file_id:saved.id,content_type:parsed.contentType,bytes:parsed.buffer.length});
    }
    if(files.length!==incomingFiles.length) throw new Error('Not every selected image was persisted.');
    let metadataSaved=null;
    if(metadataOnly){
      const current=await driveStore.readCapture(id);
      if(current){
        const merged={...current.record,...record,created_at:current.record.created_at||record.created_at,files:current.record.files||[]};
        await driveStore.updateCapture(id,merged);
        console.log(`Updated capture ${id} metadata in Drive`);
        return {ok:true,id,saved_files:(merged.files||[]).map(x=>x.name),file_count:(merged.files||[]).length,bytes_saved:(merged.files||[]).reduce((n,f)=>n+(f.bytes||0),0),storage:'google-drive',destination:destinationFor(scope),record:merged};
      }
    }
    if(!deferMetadata){
      metadataSaved=await driveStore.uploadFile({
        name:`${id}_metadata.json`,
        buffer:Buffer.from(JSON.stringify(record,null,2)),
        contentType:'application/json',
        captureId:id,
        kind:record.kind,
        role:'metadata',
        scope
      });
    }
    console.log(`Saved capture ${id}: ${files.length} file(s), ${files.reduce((n,f)=>n+f.bytes,0)} bytes to Drive`);
    return {
      ok:true,
      id,
      saved_files:files.map(x=>x.name),
      file_count:files.length,
      bytes_saved:files.reduce((n,f)=>n+f.bytes,0),
      storage:'google-drive',
      destination:destinationFor(scope),
      metadata_file_id:metadataSaved?.id||null,
      record
    };
  }

  if(storageBucket){
    for(const f of incomingFiles){
      const parsed=parseDataUrl(f.dataUrl);
      if(!parsed) throw new Error(`Image data was missing or invalid for ${f.name||'capture'}.`);
      if(parsed.buffer.length===0) throw new Error(`Image ${f.name||'capture'} was empty.`);
      const fn=safeName(f.name||'capture.bin');
      const object=`captures/${scope}/${id}/${fn}`;
      await gcsUpload(object, parsed.buffer, parsed.contentType);
      files.push({name:fn,object,content_type:parsed.contentType,bytes:parsed.buffer.length});
    }
    if(files.length!==incomingFiles.length) throw new Error('Not every selected image was persisted.');
    if(!deferMetadata) await gcsUpload(`captures/${scope}/${id}/metadata.json`,Buffer.from(JSON.stringify(record,null,2)),'application/json');
    console.log(`Saved capture ${id}: ${files.length} file(s), ${files.reduce((n,f)=>n+f.bytes,0)} bytes to GCS`);
    return {
      ok:true,
      id,
      saved_files:files.map(x=>x.name),
      file_count:files.length,
      bytes_saved:files.reduce((n,f)=>n+f.bytes,0),
      storage:'google-cloud-storage',
      bucket:storageBucket,
      destination:destinationFor(scope),
      record
    };
  }

  const dir=path.join(uploadDir,scope,id);
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
  if(!deferMetadata){
    await fs.writeFile(path.join(dir,'metadata.json'),JSON.stringify(record,null,2));
    await fs.appendFile(path.join(dataDir,'index.ndjson'),JSON.stringify(record)+'\n');
  }
  console.log(`Saved capture ${id}: ${files.length} file(s), ${files.reduce((n,f)=>n+f.bytes,0)} bytes locally`);
  return {
    ok:true,
    id,
    saved_files:files.map(x=>x.name),
    file_count:files.length,
    bytes_saved:files.reduce((n,f)=>n+f.bytes,0),
    storage:'local-development',
    destination:destinationFor(scope),
    record
  };
}

const patchFields=new Set([
  'workflow_status','recognition_status','destination','category','title','context','tags',
  'confidence','destination_hint','extracted','analysis_source','analyzed_at','message'
]);

function cleanStatusPatch(value){
  const clean={};
  if(!value || typeof value!=='object' || Array.isArray(value)) return clean;
  for(const [key,item] of Object.entries(value)) if(patchFields.has(key)) clean[key]=item;
  return clean;
}

async function readCapture(id,scope){
  const driveStore=driveStoreFor(scope);
  if(driveStore.configured) return (await driveStore.readCapture(id))?.record||null;
  if(storageBucket) return await gcsRead(`captures/${scope}/${id}/metadata.json`);
  try { return JSON.parse(await fs.readFile(path.join(uploadDir,scope,id,'metadata.json'),'utf8')); }
  catch(e){ if(e.code==='ENOENT') return null; throw e; }
}

async function updateCapture(id,scope,patch){
  const driveStore=driveStoreFor(scope);
  if(driveStore.configured) return await driveStore.updateCapture(id,patch);
  const current=await readCapture(id,scope);
  if(!current) return null;
  const record={...current,...patch,id,scope,updated_at:new Date().toISOString()};
  if(storageBucket) await gcsUpload(`captures/${scope}/${id}/metadata.json`,Buffer.from(JSON.stringify(record,null,2)),'application/json');
  else await fs.writeFile(path.join(uploadDir,scope,id,'metadata.json'),JSON.stringify(record,null,2));
  return record;
}

async function api(req,res,url){
  if(req.method==='GET' && url.pathname==='/api/health'){
    return json(res,200,{
      ok:true,
      app:'Smart Capturer',
      revision:3,
      auth_required:Boolean(accessKey),
      storage:personalDriveStore.configured?'google-drive':storageBucket?'gcs':'local-development',
      scopes:{personal:true,work:workDriveStore.configured||Boolean(storageBucket)||!personalDriveStore.configured},
      ai:analyzer.configured,
      ai_provider:analyzer.provider,
      ai_model:analyzer.model
    });
  }
  if(!authorized(req)) return json(res,401,{error:'Family access code required'});

  if(req.method==='POST' && url.pathname==='/api/analyze'){
    const p=await bodyJson(req);
    const base=fallbackContext({kind:p.kind,text:p.text,filename:p.file?.name});
    return json(res,200,await analyzer.analyze(p,base));
  }

  if(req.method==='POST' && url.pathname==='/api/save'){
    return json(res,200,await saveCapture(await bodyJson(req)));
  }

  const statusMatch=url.pathname.match(/^\/api\/captures\/([a-zA-Z0-9-]{10,120})$/);
  if(statusMatch && req.method==='GET'){
    const record=await readCapture(statusMatch[1],captureScope(url.searchParams.get('scope')));
    return record ? json(res,200,{ok:true,record}) : json(res,404,{error:'Capture not found'});
  }
  if(statusMatch && req.method==='PATCH'){
    const patch=cleanStatusPatch(await bodyJson(req,2*1024*1024));
    if(!Object.keys(patch).length) return json(res,400,{error:'No supported status fields were provided'});
    const record=await updateCapture(statusMatch[1],captureScope(url.searchParams.get('scope')),patch);
    return record ? json(res,200,{ok:true,record}) : json(res,404,{error:'Capture not found'});
  }

  return json(res,404,{error:'Not found'});
}

async function serve(req,res,url){
  let rel=decodeURIComponent(url.pathname);
  if(rel==='/' || rel==='/capture' || rel==='/work') rel='/index.html';
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

server.listen(port,'0.0.0.0',()=>console.log(`Smart Capturer listening on ${server.address().port}`));
