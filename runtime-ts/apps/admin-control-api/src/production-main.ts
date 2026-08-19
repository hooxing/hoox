import {
  selectAdminControlApiProcessEnvironment,
  startAdminControlApiProcess,
} from "./process-entry.js";

const environment = selectAdminControlApiProcessEnvironment(process.env);
if (environment.RUNTIME_ENV !== "production") throw new Error("PRODUCTION_ADMIN_CONTROL_ONLY");
await startAdminControlApiProcess({ environment });
