import { createPiModelCatalog } from "@hoox/protocol/pi-model-catalog";

const catalog = createPiModelCatalog();

export const listLocalPiModelCatalogProviders = catalog.listProviders;
export const findLocalPiModelCatalogModels = catalog.findModels;
