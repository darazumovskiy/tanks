// Все начертания подключённого набора — до первого кадра: холст не ждёт шрифт и нарисовал бы запасным.
export async function waitForFonts(): Promise<void> {
  if (document.readyState !== 'complete') {
    await new Promise<void>((resolve) => {
      window.addEventListener(
        'load',
        () => {
          resolve();
        },
        { once: true },
      );
    });
  }
  const faces: FontFace[] = [];
  document.fonts.forEach((face) => {
    faces.push(face);
  });
  if (faces.length === 0) {
    throw new Error('шрифты игры не подключились');
  }
  await Promise.all(faces.map((face) => face.load()));
  await document.fonts.ready;
}
