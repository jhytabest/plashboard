import { registerPlashboardPlugin } from './plugin.js';

export default {
  register(api: unknown) {
    registerPlashboardPlugin(api as Parameters<typeof registerPlashboardPlugin>[0]);
  }
};
