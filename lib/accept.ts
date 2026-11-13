// What a message to Bike can carry (Home's box and a chat's): the documents a build reads. One list, so Home and a
// chat never differ again (#8: Home's box took only CSV and PDF, so a pack's Word write-up and zip couldn't be picked).
// Every kind here is one the server takes (server/files/limits.ts, checked in lib/accept.test.ts).
export const MESSAGE_FILES = ".pdf,.docx,.md,.xlsx,.csv,.zip";
