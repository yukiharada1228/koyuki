import test from 'node:test';
import assert from 'node:assert/strict';
import { business, step, ok, err, type Result, type Execution, type Receipt, type ReplayInputError } from './framework/index.js';
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true>=T;
type Base=Readonly<{id:string}>;
type Scope=Readonly<{tenant:'one'}>;
type Scoped=Base & Scope;
type Submit=Base & Readonly<{approver:string}>;
type ScopedSubmit=Submit & Scope;
type Context<I>=Readonly<{input:I;actor:string}>;
type Submitted=Readonly<{state:'submitted';by:string}>;
const verified:unique symbol=Symbol('verified');
type Verified=Readonly<{[verified]:true}>;
const proof:Verified={[verified]:true};
function fixture(){
  const calls:string[]=[];
  const load=async<I extends Scoped>(input:I):Promise<Result<Context<I>,'LoadFailed'>>=>{
    calls.push('load');return input.id==='missing'?err('LoadFailed'):ok({input,actor:'host'});
  };
  const common=<T extends Context<Base>>(value:T):Result<T & Verified,'Denied'>=>{
    calls.push('common');return value.input.id==='denied'?err('Denied'):ok({...value,...proof});
  };
  const submit=(value:Context<Submit> & Verified):Result<Submitted,'InvalidApprover'>=>{
    calls.push('submit');return value.input.approver?ok({state:'submitted',by:value.actor}):err('InvalidApprover');
  };
  const save=async(value:Submitted):Promise<Result<Submitted,'SaveFailed'>>=>{calls.push('save');return ok(value);};
  return {calls,load,common,submit,save};
}
for(const local of [false,true])test(`loader input conditions and later request fields compose with ${local?'local':'shared'} load`,async()=>{
  const f=fixture();
  const app=local?business({name:'local-scope',save:f.save,operations:{submit:{load:f.load,run:[step('check',f.common),f.submit]}}})
    :business({name:'shared-scope',load:f.load,save:f.save,operations:{submit:[f.common,f.submit]}});
  type Input=Assert<Equal<Parameters<typeof app.submit>[0],ScopedSubmit>>;
  type Output=Assert<Equal<Awaited<ReturnType<typeof app.submit>>,Result<Submitted,'LoadFailed'|'Denied'|'InvalidApprover'|'SaveFailed'>>>;
  assert.deepEqual(f.calls,[]);
  assert.deepEqual(await app.submit({id:'one',tenant:'one',approver:'boss'}),ok({state:'submitted',by:'host'}));
  assert.deepEqual(f.calls.splice(0),['load','common','submit','save']);
  const extra:ScopedSubmit & Readonly<{actor:string}>={id:'extra',tenant:'one',approver:'boss',actor:'caller'};
  assert.deepEqual(await app.submit(extra),ok({state:'submitted',by:'host'}));
  assert.deepEqual(f.calls.splice(0),['load','common','submit','save']);
  const detail=await app.submit.runDetailed({id:'two',tenant:'one',approver:'boss'});
  assert.deepEqual(detail.result,ok({state:'submitted',by:'host'}));
  assert.deepEqual(f.calls.splice(0),['load','common','submit','save']);
  for(const [id,approver,error,calls]of[
    ['missing','boss','LoadFailed',['load']],['denied','boss','Denied',['load','common']],
    ['one','','InvalidApprover',['load','common','submit']],
  ]as const){
    assert.deepEqual(await app.submit({id,tenant:'one',approver}),err(error));assert.deepEqual(f.calls.splice(0),calls);
  }
  if(false){
    // @ts-expect-error A later field cannot remove the loader's required tenant.
    void app.submit({id:'one',approver:'boss'});
    // @ts-expect-error The loader's literal scope is retained.
    void app.submit({id:'one',tenant:'two',approver:'boss'});
    // @ts-expect-error Keeping the loader scope cannot remove the later field.
    void app.submit({id:'one',tenant:'one'});
    // @ts-expect-error actor is not a declared request property.
    void app.submit({id:'one',tenant:'one',approver:'boss',actor:'caller'});
    const readyLoad=<I extends ScopedSubmit>(input:I)=>f.load(input);
    const otherScope=(value:Context<Submit & Readonly<{tenant:'two'}>> & Verified):Result<Submitted,never>=>ok({state:'submitted',by:value.actor});
    // @ts-expect-error A complete request still cannot satisfy contradictory tenant literals.
    business({name:'conflicting-scope',load:readyLoad,save:f.save,operations:{submit:[f.common,otherScope]}});
  }
});
test('scoped requests reach replay lookup and keep both sets of input conditions',async()=>{
  const f=fixture();
  const save=async(value:Submitted):Promise<Result<Execution<Submitted>,'SaveFailed'>>=>{
    f.calls.push('save');return ok({kind:'committed',value});
  };
  const app=business({name:'scope-replay',load:f.load,save,operations:{submit:[f.common,f.submit]},replay:{
    lookup:execution=>{
      type Input=Assert<Equal<typeof execution.request,ScopedSubmit>>;
      type Name=Assert<Equal<typeof execution.name,'submit'>>;
      f.calls.push('lookup');
      const result:Result<Receipt<Submitted>,'LookupFailed'>=execution.request.id==='cached'
        ?ok({kind:'found',value:{state:'submitted',by:'history'}}):ok({kind:'missing'});
      return result;
    },resolveAfter:[],
  }});
  type Input=Assert<Equal<Parameters<typeof app.submit>[0],ScopedSubmit>>;
  type Output=Assert<Equal<Awaited<ReturnType<typeof app.submit>>,Result<Execution<Submitted>,'LoadFailed'|'Denied'|'InvalidApprover'|'SaveFailed'|'LookupFailed'|ReplayInputError>>>;
  assert.deepEqual(await app.submit({id:'cached',tenant:'one',approver:'boss'}),ok({kind:'replayed',value:{state:'submitted',by:'history'}}));
  assert.deepEqual(f.calls.splice(0),['lookup']);
  assert.deepEqual(await app.submit({id:'one',tenant:'one',approver:'boss'}),ok({kind:'committed',value:{state:'submitted',by:'host'}}));
  assert.deepEqual(f.calls,['lookup','load','common','submit','save']);
  if(false){
    // @ts-expect-error Replay retains the loader's required scope too.
    void app.submit({id:'cached',approver:'boss'});
  }
});
