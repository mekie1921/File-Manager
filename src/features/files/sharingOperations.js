export async function shareFilesOneAtATime(files, confirmNext, shareOne) {
  let completedCount = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const shouldShare = await confirmNext(file, index, files.length);
    if (!shouldShare) {
      return { completedCount, stopped: true };
    }
    await shareOne(file);
    completedCount += 1;
  }

  return { completedCount, stopped: false };
}
