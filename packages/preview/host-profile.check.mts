import {test} from 'node:test'
import assert from 'node:assert/strict'
import {appendRuntimePlugin,assertRuntimeProfile} from './host-profile.mjs'
import {pluginPath} from './environment.mjs'
test('runtime plugin is appended without changing routing or permissions, exact resolved list required',()=>{
 const observation='/fixture/observation.ts',config={plugin:[observation],model:'chaos-qwen/code-agent',small_model:'chaos-qwen/metadata',enabled_providers:['chaos-qwen'],mcp:{},permission:{external_directory:'ask'}}
 const env=appendRuntimePlugin({OPENCODE_CONFIG_CONTENT:JSON.stringify(config)},observation),next=JSON.parse(env.OPENCODE_CONFIG_CONTENT!)
 assert.deepEqual(next,{...config,plugin:[observation,pluginPath]})
 const resolved={...next,plugin_origins:next.plugin.map((spec:string)=>({spec}))}
 assert.doesNotThrow(()=>assertRuntimeProfile(resolved,observation))
 assert.throws(()=>assertRuntimeProfile({...resolved,plugin:[...resolved.plugin,'/extra']},observation))
 assert.throws(()=>assertRuntimeProfile({...resolved,plugin_origins:[...resolved.plugin_origins,{spec:'/extra'}]},observation))
 assert.throws(()=>assertRuntimeProfile({...resolved,model:'other/model'},observation))
 assert.throws(()=>appendRuntimePlugin({OPENCODE_CONFIG_CONTENT:JSON.stringify({...config,plugin:['/other']})},observation))
})
