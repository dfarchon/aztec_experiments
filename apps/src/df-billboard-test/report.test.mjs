import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server.js';
import { createReadingReport, reportEffect } from './report-data.mjs';

function fixture() {
  const original = { normal_zh: ['我们反对代练。', '<img src=x onerror=alert(1)>'],
    advertising_zh: ['专业代练接单，加微信 demo 咨询价格。'], toxic_zh: ['风险测试文本'], policy_zh: ['联盟招募'], duplicatePairs: [] };
  const rows = Object.entries(original).filter(([key]) => key !== 'duplicatePairs').flatMap(([group, texts]) => texts.map((text, i) => ({
    id: `${group}-${i + 1}`, text, group, language:'zh', dataset:'original96', flagged:group === 'toxic_zh', labels:group === 'toxic_zh' ? ['harassment'] : [],
  })));
  return { original, holdout:{samples:[],duplicatePairs:[]}, browser:{done:true,rows,startedAt:'2026-10-14T04:03:01Z',elapsedMs:8981},
    metadata:{repo:'test-model',revision:'fixed',decision:'unsafe >= 0.5'} };
}

test('report derives category counts and separates promotion from discussion labels',()=>{
  const report=createReadingReport(fixture());
  assert.equal(report.rows.length,5);
  assert.deepEqual(report.summary.find(row=>row.category==='normal'),{category:'normal',total:2,keyword:1,promotion:0,adFold:0,aiRisk:0});
  assert.equal(report.rows[0].adTier,'context');
  assert.equal(report.summary.find(row=>row.category==='advertising').adFold,1);
});

test('all switch combinations preserve AI as hint only and count fold union once',()=>{
  const report=createReadingReport(fixture());
  for (const keyword of [false,true]) for (const ad of [false,true]) for (const ai of [false,true]) for (const adMode of ['hint','fold']) {
    const options={keyword,ad,ai,adMode};
    const result=reportEffect(report.rows[2],options);
    assert.equal(result.folded,keyword||(ad&&adMode==='fold'));
    assert.equal(reportEffect(report.rows[3],options).folded,false);
    assert.equal(reportEffect(report.rows[3],options).aiRisk,ai);
  }
});

test('incomplete, duplicated or changed evidence fails closed instead of reporting zero errors',()=>{
  const input=fixture();input.browser.done=false;
  assert.throws(()=>createReadingReport(input),/未完成/);
  input.browser.done=true;input.browser.rows[0].text='changed';
  assert.throws(()=>createReadingReport(input),/不一致/);
  const duplicate=fixture();duplicate.browser.rows[1]=duplicate.browser.rows[0];
  assert.throws(()=>createReadingReport(duplicate),/不一致/);
});

const compiled=await build({stdin:{contents:"export { ReportContent } from './ReportPage.tsx';",resolveDir:fileURLToPath(new URL('.',import.meta.url))},
  bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,loader:{'.css':'empty'},external:['react','react/jsx-runtime','react-router-dom']});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
test('report renders documentation navigation, historic provenance and escaped samples without wallet controls',()=>{
  const html=renderToStaticMarkup(createElement(StaticRouter,{location:'/reports'},createElement(module.exports.ReportContent,{report:createReadingReport(fixture())})));
  for(const id of ['overview','switches','samples','design','limits','evidence']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html,/<img|id="walletMenu"|id="connect"/);
  assert.match(html,/不会启动模型/);
  assert.match(html,/df-test-report.json/);
  assert.match(html,/本页实现时的回归记录/);
});
