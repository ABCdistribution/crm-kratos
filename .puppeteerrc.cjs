/**
 * Puppeteer n'est présent que via prisma-erd-generator (sortie Mermaid .md,
 * aucun rendu navigateur). On ne télécharge donc jamais Chrome sur le serveur.
 */
module.exports = {
  skipDownload: true,
};
