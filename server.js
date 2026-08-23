import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import "dotenv/config";
import OpenAI from "openai";

const app = express();
app.use(express.json({limit:"1mb"}));

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN}));

const PORT = Number(process.env.PORT || 8787);
const MAX_WORDS = 5000;
const scans = new Map();

function wordCount(text){ return (String(text||"").trim().match(/\S+/g)||[]).length; }
function assertText(text){
  if(typeof text!=="string" || !text.trim()) throw new Error("Text is required.");
  if(wordCount(text)>MAX_WORDS) throw new Error("Maximum 5,000 words per request.");
}
function requireEnv(name){
  if(!process.env[name]) throw new Error(`${name} is not configured on the server.`);
}
function scanId(){ return crypto.randomBytes(12).toString("hex"); }

let copyleaksToken = {value:null, expiresAt:0};
async function getCopyleaksToken(){
  requireEnv("COPYLEAKS_EMAIL"); requireEnv("COPYLEAKS_API_KEY");
  if(copyleaksToken.value && Date.now()<copyleaksToken.expiresAt) return copyleaksToken.value;
  const r=await fetch("https://id.copyleaks.com/v3/account/login/api",{
    method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},
    body:JSON.stringify({email:process.env.COPYLEAKS_EMAIL,key:process.env.COPYLEAKS_API_KEY})
  });
  const d=await r.json();
  if(!r.ok) throw new Error(d.message||"Copyleaks authentication failed.");
  copyleaksToken={value:d.access_token,expiresAt:Date.now()+43*60*60*1000};
  return d.access_token;
}

app.get("/api/health",(req,res)=>res.json({ok:true,service:"DPT-Detector",time:new Date().toISOString()}));

app.post("/api/plagiarism",async(req,res)=>{
  try{
    const {text}=req.body; assertText(text);
    const id=scanId();
    const webhookBase=process.env.PUBLIC_BACKEND_URL;
    if(!webhookBase) throw new Error("PUBLIC_BACKEND_URL is not configured. The plagiarism provider needs a public HTTPS webhook URL.");
    const token=await getCopyleaksToken();
    scans.set(id,{status:"submitted",createdAt:Date.now(),results:null,error:null});
    const body={
      base64:Buffer.from(text,"utf8").toString("base64"),
      filename:"dpt-detector.txt",
      properties:{
        webhooks:{
          status:`${webhookBase.replace(/\/$/,"")}/webhooks/copyleaks/{STATUS}/${id}`,
          newResult:`${webhookBase.replace(/\/$/,"")}/webhooks/copyleaks/new-result/${id}`
        },
        scanning:{internet:true},
        filters:{identicalEnabled:true,minorChangesEnabled:true,relatedMeaningEnabled:true},
        sandbox:process.env.COPYLEAKS_SANDBOX==="true",
        developerPayload:id
      }
    };
    const r=await fetch(`https://api.copyleaks.com/v3/scans/submit/file/${id}`,{
      method:"PUT",headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"},
      body:JSON.stringify(body)
    });
    const d=await r.json();
    if(!r.ok){scans.delete(id);throw new Error(d.message||"Copyleaks scan submission failed.");}
    scans.get(id).provider=d;
    res.status(202).json({scanId:id,status:"submitted"});
  }catch(e){res.status(400).json({error:e.message});}
});

app.get("/api/plagiarism/:id",(req,res)=>{
  const s=scans.get(req.params.id);
  if(!s)return res.status(404).json({error:"Scan not found or expired."});
  res.json(s);
});

function acceptWebhook(req,res){
  const id=req.params.id;
  const s=scans.get(id);
  if(!s)return res.status(200).json({ok:true});
  const payload=req.body||{};
  s.webhookAt=Date.now();
  if(req.params.status==="completed"){
    s.status="completed"; s.results=payload.results||{}; s.document=payload.scannedDocument||{};
  }else if(req.params.status==="error"){
    s.status="error"; s.error=payload.error?.message||"The plagiarism scan failed.";
  }else{
    s.status=req.params.status||"processing";
  }
  res.status(200).json({ok:true});
}
app.post("/webhooks/copyleaks/:status/:id",acceptWebhook);

app.post("/webhooks/copyleaks/new-result/:id",(req,res)=>{
  const s=scans.get(req.params.id);
  if(s){
    s.liveResults=s.liveResults||[];
    if(req.body?.internet) s.liveResults.push(...req.body.internet);
  }
  res.status(200).json({ok:true});
});

app.post("/api/rewrite",async(req,res)=>{
  try{
    const {text,style="Natural"}=req.body;assertText(text);requireEnv("OPENAI_API_KEY");
    const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
    const response=await client.responses.create({
      model:process.env.OPENAI_MODEL||"gpt-5.6",
      store:false,
      instructions:`You are DPT-Detector's writing improvement engine. Rewrite the user's text in a genuinely natural, fluent way while preserving its meaning, facts, intent, and approximate length. Style: ${style}. Improve sentence variety, transitions, clarity, word choice, and awkward phrasing. Do not add invented facts. Do not claim the result is guaranteed to evade AI detectors, plagiarism systems, or academic-integrity checks. Return only the rewritten text, with no preface or explanation.`,
      input:text
    });
    res.json({text:response.output_text});
  }catch(e){res.status(400).json({error:e.message||"Rewrite failed."});}
});

app.use(express.static(new URL("../frontend/",import.meta.url).pathname));
app.listen(PORT,()=>console.log(`DPT-Detector backend running on http://localhost:${PORT}`));
