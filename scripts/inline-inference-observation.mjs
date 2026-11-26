// Development-only observation: a known compiler limitation is not a required refusal.
export function classifyInlineInference(source, result) {
  if (result.error || result.signal || ![0, 1, 2].includes(result.status)) throw Error('Inline inference compiler did not complete');
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const errors = output.split('\n').filter(line => /error TS\d+:/.test(line));
  const lines = source.split('\n');
  const site = marker => {
    const matches = lines.flatMap((line, index) => line.includes(marker) ? [index + 1] : []);
    if (matches.length !== 1) throw Error(`Inline probe marker changed: ${marker}`);
    return matches[0];
  };
  const required = site('// probe:require'), evolved = site('// probe:evolve'), exact = site('// probe:exact-result');
  if (!source.includes('const exactInlineInput: Equal<Parameters<typeof inline.run>[0], number> = true;')
      || !lines[exact - 1].includes('const exactInlineResult: Equal<ReturnType<typeof inline.run>')
      || !lines[exact - 1].includes(' = true;')) throw Error('Inline input/result precision contracts are missing');
  if (result.status === 0) {
    if (errors.length) throw Error('Successful compiler result contains errors');
    return { status: 'supported', diagnostics: [] };
  }
  const allowed = new Map([[required, new Set([2322])], [evolved, new Set([2339, 2551])], [exact, new Set([2322])]]);
  const diagnostics = errors.map(line => {
    const match = line.match(/(?:^|[/\\])transition-inference-limit\.ts\((\d+),(\d+)\): error TS(\d+):/);
    if (!match) throw Error(`Unexpected inline inference diagnostic: ${line}`);
    const item = { line: Number(match[1]), column: Number(match[2]), code: Number(match[3]) };
    if (!allowed.get(item.line)?.has(item.code)) throw Error(`Unexpected inline inference diagnostic: ${line}`);
    return item;
  });
  // A precision failure alone is not this limitation: never accept an any/unknown
  // result just because the formerly blocked expression starts compiling.
  if (!diagnostics.some(item => item.line === required) || !diagnostics.some(item => item.line === evolved)) {
    throw Error(`Inline inference failed outside the known blocked-call pattern:\n${output}`);
  }
  return { status: 'compiler-limit', diagnostics };
}
