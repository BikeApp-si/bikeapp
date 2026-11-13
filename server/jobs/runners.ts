import { runBuild } from "@/server/chat/build";
import { runBuildRead } from "@/server/chat/build-read";
import { runCreate } from "@/server/chat/create";
import { runReportJob } from "@/server/chat/report";
import { runDesign } from "@/server/chat/design";
import { runImport } from "@/server/chat/import";
import { runImportInto } from "@/server/chat/import-into";
import { runAiStep } from "@/server/ai-step/run";
import { runOntology } from "@/server/ontology/write";
import { register } from "./run";

// What each kind of job runs. The worker imports this once; tests import it to run jobs in-process.
register("design", runDesign);
register("import", runImport);
register("import-into", runImportInto);
register("create", runCreate);
register("build-read", runBuildRead);
register("build", runBuild);
register("ontology", runOntology);
register("ai-step", runAiStep);
register("report", runReportJob);
