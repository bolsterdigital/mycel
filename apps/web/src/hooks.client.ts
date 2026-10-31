// Disable Zod's Function-based environment probe before hydrated routes import core schemas.
// Configuring only the editor runs too late when the bundler shares Zod and schema chunks.
import { z } from 'zod';

z.config({ jitless: true });
