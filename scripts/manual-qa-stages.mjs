// Observation callbacks must only read; gestures belong exclusively to the human.
export async function runHumanStage({ instruction, instruct, observe, acknowledge }) {
  instruct(instruction);
  if (await observe() !== true) throw new Error('human stage observable predicate failed');
  if (await acknowledge() !== 'DONE') throw new Error('human stage acknowledgement missing');
  return true;
}
