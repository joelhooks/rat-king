export const githubBudget = () => {
  const charges: number[] = [];

  return (now: number): (() => void) | null => {
    while ((charges[0] ?? Infinity) <= now - 3_600_000) {
      charges.shift();
    }

    if (charges.length >= 39) {
      return null;
    }

    charges.push(now);

    return () => {
      const index = charges.lastIndexOf(now);

      if (index !== -1) {
        charges.splice(index, 1);
      }
    };
  };
};
