// Development-only QA preview. Uses the real Worker with deterministic AI replies.
// No provider credentials are read and no external API requests are made.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const port = 8788;
const origin = `http://127.0.0.1:${port}`;
const types = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".mjs":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".jpg":"image/jpeg", ".png":"image/png", ".woff2":"font/woff2", ".txt":"text/plain; charset=utf-8", ".xml":"application/xml" };

globalThis.fetch = async (url, options) => {
  if (String(url) !== "https://api.anthropic.com/v1/messages") throw new Error("External requests are disabled in the QA preview.");
  const request = JSON.parse(options.body);
  const content = request.messages[0].content;
  const input = content.find(item => item.type === "text").text;
  if (input.includes("QA_ERROR")) return Response.json({ error: "busy" }, { status: 529 });
  await new Promise(resolve => setTimeout(resolve, input.includes("QA_SLOW") ? 8000 : 600));
  const count = content.filter(item => item.type === "image").length;
  const report = {
    overall: 76, headline: "Your interests give someone a way in.",
    summary: "This is a development sample report. Your real report will use the photos and prompts you share. Keep the concrete details and give someone an easy question to answer.",
    strengths: ["A clear interest is a good conversation starter."],
    metrics: [{name:"Prompt hooks",score:7.6,note:"One specific question can make the next message easier."}],
    photos: Array.from({length:count}, (_,i)=>({upload:i+1,label:`Uploaded photo ${i+1}`,verdict:"fix",score:7.2,what:"This sample tests the photo report and editor flow.",fix:"Try a little more light and a tighter crop.",bench:{zoom:1.1,panX:0,panY:0,brightness:6,contrast:2,warmth:0,saturation:0},annotations:i===0 ? [{kind:"strength",x:79,y:7,width:21,height:67,label:"Hobby: guitar"}] : [],annotation:null})),
    order: Array.from({length:count},(_,i)=>`Uploaded photo ${i+1}`),
    prompts: [{prompt:"My simple pleasures",verdict:"fix",current:"Coffee and hiking.",rewrite:"An early trail, a strong coffee, and a Sunday with no plans. What's your go-to reset?",why:"Specific details give someone a starting point."}],
    fixes: [{impact:"high",action:"Add one specific detail to your main prompt."},{impact:"med",action:"Finish with a question that is easy to answer."}],
  };
  if (input.includes("Transcript from speech recognition")) report.voice = {score:7.5,verdict:"keep",what:"The sample transcript is clear.",fix:"Keep the relaxed pace.",script:"An early trail, a strong coffee, and a Sunday with no plans. What's your go-to reset?",why:"An easy question opens a conversation."};
  return Response.json({stop_reason:"end_turn",content:[{type:"text",text:JSON.stringify(report)}]});
};

const env = {
  ANTHROPIC_API_KEY:"development-placeholder", ALLOWED_ORIGINS:origin,
  SCAN_LIMITER:{limit:async()=>({success:true})},
  AI:{run:async()=>({text:"My simple pleasures are coffee hiking and Sunday mornings with friends."})},
  ASSETS:{fetch:async request=>{
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const filename = path.resolve(root, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!filename.startsWith(root + path.sep)) return new Response("Not found",{status:404});
    try { const bytes = await readFile(filename); return new Response(request.method === "HEAD" ? null : bytes,{headers:{"content-type":types[path.extname(filename)] || "application/octet-stream"}}); }
    catch { return new Response("Not found",{status:404}); }
  }},
};
http.createServer(async (req,res)=>{
  try {
    const body=[]; for await (const chunk of req) body.push(chunk);
    const request = new Request(new URL(req.url,origin),{method:req.method,headers:req.headers,...(body.length?{body:Buffer.concat(body)}:{})});
    const response = await worker.fetch(request,env);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end("Preview request failed"); }
}).listen(port,"127.0.0.1",()=>process.stdout.write(`QA preview: ${origin}\nAI replies are simulated; production is unaffected.\n`));
