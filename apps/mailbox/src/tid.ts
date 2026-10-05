export const tid = (millis: number, clockId: number) => {
  let number = BigInt(millis) * 1000n * 1024n + BigInt(clockId % 1024);
  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
  let text = "";

  for (let index = 0; index < 13; index += 1) {
    text = (alphabet[Number(number % 32n)] ?? "2") + text;
    number /= 32n;
  }

  return text;
};
