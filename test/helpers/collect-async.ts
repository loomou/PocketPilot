export async function collectAsync<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of input) {
    values.push(value);
  }
  return values;
}
