import { loadDevelopmentEnvironment } from "@hoox/process-runtime";
import {
  selectAdminControlApiProcessEnvironment,
  startAdminControlApiProcess,
} from "./process-entry.js";

const environment = selectAdminControlApiProcessEnvironment(
  await loadDevelopmentEnvironment(process.env, new URL("../../../../.env", import.meta.url)),
);
if (environment.RUNTIME_ENV === "production") throw new Error("DEVELOPMENT_ADMIN_CONTROL_ONLY");
await startAdminControlApiProcess({ environment });
