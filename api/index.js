export default async (req, res) => {
  const { reqHandler } = await import('../dist/server/server.mjs');
  return reqHandler(req, res);
};
