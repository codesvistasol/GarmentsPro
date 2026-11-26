import { app } from './index.js';
import { testAuthBypass } from './staff-context.js';

if (testAuthBypass()) throw new Error('The test authentication bypass cannot be used by the API server');

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '127.0.0.1';
app.listen(port, host, () => console.log(`GarmentPro API running at http://${host}:${port}`));
