import express from 'express';

const app = express();
const port = Number(process.env.PORT || 3001);

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'client-management-api'
  });
});

app.use((_req, res) => {
  res.status(404).json({
    error: 'Not found'
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Client Management API listening on port ${port}`);
});
