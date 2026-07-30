import type { Script } from './db';

/**
 * Rig-test scripts, seeded once on devices that don't have them. They
 * self-narrate the Phase A test protocol: the instructions are script
 * lines the tester reads aloud, so following them exercises advance,
 * hold/rejoin (ad-lib), and skip-forward — hands-free. The red lines
 * are the deliberate-skip targets and must stay within the matcher's
 * 3-phrase lookahead (guarded by unit tests).
 */
export const RIG_SCRIPTS: Script[] = [
  {
    id: 'rigtest-en',
    title: 'Rig test — English (60s)',
    lang: 'en-US',
    updated: 0, // stamped at seed time
    body: `This is the sixty second rig test. Read every line at your normal pace, and the words will follow you.

Each phrase appears large, the next one waiting below. Nothing scrolls on this screen. It only moves when you speak.

Now read this sentence aloud, then stop and ad-lib about something else, like the weather, for about eight seconds. When you are done, come back and read this exact line.

Good. The prompter waited for you, and it found you again the moment you returned.

Next comes the skipping test. Read this sentence, then jump past the red line below. {red:Purple elephants juggle rocks.} Pick up right here instead and keep going to the end.

The screen stayed with you the whole way through. Check the numbers in the corner, and you are done.`,
  },
  {
    id: 'rigtest-pt',
    title: 'Teste do rig — Português (60s)',
    lang: 'pt-BR',
    updated: 0,
    body: `Este é o teste de sessenta segundos. Leia cada linha no seu ritmo normal, e as palavras vão seguir você.

Cada frase aparece grande no centro, com a próxima esperando embaixo. Nada fica rolando nesta tela. Ela só avança quando você fala.

Agora leia esta frase em voz alta, depois pare e improvise sobre outro assunto, como comida, por uns oito segundos. Quando quiser voltar, leia esta linha aqui.

Muito bem. O prompter esperou por você e te encontrou de novo assim que você voltou.

Agora vem o teste de pular linhas. Leia esta frase, depois pule a linha vermelha abaixo. {red:Elefantes roxos no palco.} Retome daqui mesmo e siga até o final.

A tela ficou com você o tempo todo. Respire fundo, olhe os números no canto, e pronto.`,
  },
];
