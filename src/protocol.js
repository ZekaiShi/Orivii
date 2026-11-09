// Both DSH faces require the same strict input contract. The browser receives
// its Zod runtime from DSH's static modules; the Host uses the package dependency.
export function createDotRemote(z) {
  const profile=z.strictObject({preferredName:z.string().max(80).optional(),identity:z.string().max(1200).optional(),preferences:z.string().max(2000).optional()})
  const settings=z.strictObject({
    name:z.string().max(200).optional(),persona:z.string().max(6000).optional(),
    provider:z.string().max(200).optional(),model:z.string().max(200).optional(),
    ...Object.fromEntries(['bubbleColor','replyColor','characterColor'].map(k=>[k,z.string().regex(/^(?:#[\da-fA-F]{6})?$/).optional()])),
    shortBudget:z.number().int().min(100000).max(200000).optional(),
    mediumBudget:z.number().int().min(10000).max(200000).optional(),
    mediumContextBudget:z.number().int().min(0).max(200000).optional(),
    longContextBudget:z.number().int().min(0).max(30000).optional(),autoPermanent:z.boolean().optional(),autoProfile:z.boolean().optional(),autoLearn:z.boolean().optional(),webSearch:z.boolean().optional(),eyeAnimation:z.boolean().optional(),
  })
  const id=z.string().regex(/^[a-f0-9-]{36}$/)
  const sessionMode=z.enum(['run','8h','24h'])
  const operation=(action,fields={})=>z.strictObject({action:z.literal(action),token:z.string().max(64).optional(),...fields})
  const live=z.strictObject({mediaEnabled:z.boolean().optional(),commentary:z.boolean().optional(),exploration:z.boolean().optional(),exploreTopics:z.array(z.string().max(80)).max(8).optional()})
  const request=z.discriminatedUnion('action',[
    operation('status',{workspace:z.string().max(4096).optional()}),
    operation('webCheck'),
    operation('capabilities',{query:z.strictObject({query:z.string().max(200).optional(),names:z.array(z.string().max(200)).max(5).optional(),offset:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(30).optional()}).optional()}),
    operation('biliConnection'),
    operation('modelProbe',{roundtrip:z.boolean().optional(),videoId:z.string().regex(/^BV[0-9A-Za-z]{10}$/).optional()}),
    operation('resume',{identityId:id.optional()}),operation('identities'),
    operation('sessionPolicy',{mode:sessionMode}),
    operation('identitySwitch',{identityId:id,password:z.string().max(1024).optional()}),
    operation('identityCreate',{name:z.string().min(1).max(200),persona:z.string().max(2000).optional(),password:z.string().max(1024).optional(),plaintext:z.boolean().optional(),plaintextAcknowledgement:z.string().max(100).optional(),sessionMode:sessionMode.optional()}),
    operation('liveSettings',{settings:live.optional()}),
    operation('mediaStart',{chatId:id,url:z.string().max(2048),mode:z.enum(['video','reading'])}),
    ...['mediaStop','mediaStatus'].map(action=>operation(action)),
    operation('fileBegin',{name:z.string().min(1).max(160),size:z.number().int().min(1).max(10485760),mediaType:z.string().max(100)}),
    operation('fileChunk',{id,offset:z.number().int().nonnegative(),data:z.string().max(131072)}),
    ...['fileFinish','fileCancel','fileDiscard'].map(action=>operation(action,{id})),
    operation('fileRead',{id,offset:z.number().int().nonnegative().optional()}),
    operation('extension',{request:z.record(z.string(),z.unknown())}),
    operation('setup',{workspace:z.string().max(4096).optional(),password:z.string().max(1024).optional(),settings:settings.optional(),profile:profile.optional(),plaintext:z.boolean().optional(),plaintextAcknowledgement:z.string().max(100).optional(),sessionMode:sessionMode.optional()}),
    operation('unlock',{workspace:z.string().max(4096).optional(),password:z.string().max(1024).optional(),sessionMode:sessionMode.optional()}),
    operation('snapshot',{chatId:id.nullish(),beforeId:id.optional()}),
    operation('progress',{chatId:id}),
    operation('developerMode',{enabled:z.boolean()}),
    operation('developerSnapshot',{chatId:id.nullish()}),
    ...['lock','models','cancel'].map(action=>operation(action)),
    operation('settings',{settings}),
    operation('profile',{profile}),
    operation('createChat',{title:z.string().max(200).optional()}),
    operation('editChat',{chatId:id,title:z.string().max(200).optional(),archived:z.boolean().optional()}),
    operation('send',{chatId:id,text:z.string().min(1).max(16000),requestId:z.string().min(1).max(100),attachments:z.array(id).max(4).optional()}),
    operation('search',{query:z.string().min(1).max(500)}),
    operation('source',{id}),
    operation('memories',{layer:z.enum(['medium','long','permanent','knowledge','memes'])}),
    operation('pin',{id,text:z.string().max(6000).optional()}),
    operation('editMemory',{id,text:z.string().min(1).max(6000).optional(),enabled:z.boolean().optional()}),
    operation('import',{legacyId:z.string().max(100),title:z.string().max(200).optional(),messages:z.array(z.strictObject({
      role:z.enum(['user','assistant']),text:z.string().max(200000),time:z.number().optional(),seq:z.number().optional(),
    })).max(1000)}),
  ])
  const codec={mode:'strict',typeSymbol:'dsh-companion#DotCommandRequest',create:()=>request}
  const result=z.discriminatedUnion('ok',[
    z.strictObject({ok:z.literal(true),value:z.unknown()}),
    z.strictObject({ok:z.literal(false),error:z.strictObject({code:z.string(),message:z.string()})}),
  ])
  return {
    package:'dsh-companion',
    descriptors:[{
      id:'dsh-companion#dotCompanion/command',service:'dotCompanion',namespace:'dotCompanion',
      method:'command',invocation:{kind:'direct'},
      parameters:[{name:'request',wire:'request',source:'json',codec}],
      result:{mode:'strict',typeSymbol:'dsh-companion#DotCommandResult',create:()=>result},
    }],
  }
}
