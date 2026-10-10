export const tid = (millis: number, clockId: number, micros = 0) => {
  let number =
    (BigInt(millis) * 1000n + BigInt(Math.abs(micros) % 1000)) * 1024n +
    BigInt(clockId % 1024);

  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
  let text = "";

  for (let index = 0; index < 13; index += 1) {
    text = (alphabet[Number(number % 32n)] ?? "2") + text;
    number /= 32n;
  }

  return text;
};

export const randomTid = (millis: number) => {
  const words = crypto.getRandomValues(new Uint16Array(2));

  return tid(millis, words[0] ?? 0, words[1] ?? 0);
};
