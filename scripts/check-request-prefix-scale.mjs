// A worst-case prefix accumulates one request field at each of 62 checks.
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
export function verifyRequestPrefixScale(consumer, run) {
  const source = join(consumer,'request-prefix-scale.ts');
  const config = join(consumer,'request-prefix-scale.json');
  const output = join(consumer,'request-prefix-scale-output');
  for (const path of [source,config,output]) assert(!existsSync(path),'Refusing to overwrite a scale fixture');
  const indexes=Array.from({length:62},(_,i)=>i);
  const input=(omitLast=false)=>`{id:'one',${indexes.filter(i=>!omitLast||i!==61).map(i=>`v${i}:'value'`).join(',')}}`;
  const fixture=`import { business,ok,type Result } from 'koyuki';
type Equal<A,B>=(<T>()=>T extends A?1:2)extends(<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true>=T;
type Base=Readonly<{id:string}>;type Context<I>=Readonly<{input:I}>;
${indexes.map(i=>`type R${i}=Base&Readonly<{v${i}:string}>;`).join('\n')}
type Required=Base&${indexes.map(i=>`R${i}`).join('&')};
let calls=0;
const load=async<I extends Base>(input:I):Promise<Result<Context<I>,'Load'>>=>{calls++;return ok({input});};
const common=<T extends Context<Base>>(value:T):Result<T,'Common'>=>{calls++;return ok(value);};
${indexes.map(i=>`const check${i}=<T extends Context<R${i}>>(value:T):Result<T,'E${i}'>=>{calls++;return ok(value);};`).join('\n')}
const finish=(value:Context<Required>):Result<string,never>=>{calls++;return ok(value.input.id);};
const save=async(value:string):Promise<Result<string,'Save'>>=>{calls++;return ok(value);};
const app=business({name:'prefix-scale',load,save,operations:{run:[common,${indexes.map(i=>`check${i}`).join(',')},finish]}});
type Input=Assert<Equal<Parameters<typeof app.run>[0],Required>>;
type Output=Assert<Equal<Awaited<ReturnType<typeof app.run>>,Result<string,'Load'|'Common'|'Save'|${indexes.map(i=>`'E${i}'`).join('|')}>>>;
if(false){
 // @ts-expect-error Every accumulated request field, including the last, is required.
 void app.run(${input(true)});
}
if(calls!==0)throw Error('Declaration performed work');
const result=await app.run(${input()});
if(!result.ok||result.value!=='one'||Number(calls)!==66)throw Error('The 64-stage operation did not complete once');
console.log('Verified 64 stages with 62 independently required request fields and a closed declared error union.');
`;
  try {
    writeFileSync(source,fixture);
    writeFileSync(config,JSON.stringify({compilerOptions:{strict:true,noUncheckedIndexedAccess:true,target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',types:[],lib:['ES2022','DOM'],outDir:'request-prefix-scale-output'},files:['request-prefix-scale.ts']}));
    run('npm',['exec','--','tsc','-p',config,'--pretty','false'],consumer);
    console.log(run(process.execPath,[join(output,'request-prefix-scale.js')],consumer).trim());
  } finally {
    for(const path of [source,config,output])rmSync(path,{recursive:true,force:true});
  }
}
