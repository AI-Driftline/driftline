import OpenAI from "openai";
const client = new OpenAI();
export async function parseInvoice(text: string) {
  const res = await client.responses.create({ model: "gpt-4o-2024-05-13", input: text });
  return JSON.parse(res.output_text);
}
