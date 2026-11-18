async function*a(n){let i=0;for await(let t of n){if(!["test:pass","test:fail"].includes(t.type))continue;let e=t.data;if(typeof e.name!="string"||typeof e.file!="string")continue;let s=e.details;if(!(e.name===e.file||s?.type==="suite")){if(++i>1e3){yield JSON.stringify({kind:"overflow"})+`
`;return}yield JSON.stringify({kind:"case",name:e.name,file:e.file,state:e.skip?"skipped":e.todo?"todo":t.type==="test:pass"?"passed":"failed"})+`
`}}yield JSON.stringify({kind:"complete",count:i})+`
`}export{a as default};
