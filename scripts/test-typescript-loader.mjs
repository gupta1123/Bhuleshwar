import {registerHooks} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import ts from 'typescript';
const root=fileURLToPath(new URL('../',import.meta.url));
registerHooks({
 resolve(specifier,context,next){
  let file;
  if(specifier.startsWith('@/'))file=path.join(root,'apps/api/src',specifier.slice(2));
  else if(specifier.startsWith('@autodealer/shared/'))file=path.join(root,'packages/shared/src',specifier.slice(19));
  else if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:'))file=fileURLToPath(new URL(specifier,context.parentURL));
  if(file){const found=[file,`${file}.ts`,`${file}.mjs`,path.join(file,'index.ts')].find(p=>existsSync(p)&&/\.(ts|mjs)$/.test(p));if(found)return next(pathToFileURL(found).href,context);}
  return next(specifier,context);
 },
 load(url,context,next){
  if(!url.startsWith('file:')||!url.endsWith('.ts'))return next(url,context);
  let source=readFileSync(fileURLToPath(url),'utf8');
  if(url.endsWith('/processing/pipeline.ts'))source+='\nexport {applyExtractionReviewCorrections,mapFields,cleanVisibleItemCodeCandidate};';
  if(url.endsWith('/services/verification.ts'))source+='\nexport {getSellerChainRoleSelection};';
  return {format:'module',shortCircuit:true,source:ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
 }
});
