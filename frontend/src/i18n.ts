import { useEffect, useState } from "react";

export type Locale = "pt-BR" | "en";

const pt = {
  brand: "Nexus Edge",
  installer: "Instalador Cloudflare",
  language: "English",
  eyebrow: "Nativo Cloudflare",
  introTitle: "Seu Nexus, na sua própria conta Cloudflare",
  introBody:
    "Crie Worker, banco D1, filas e agendamentos sem GitHub, Node.js ou Wrangler no seu computador.",
  signIn: "Entrar com Cloudflare",
  creates: "O que será criado",
  createsBody:
    "Core Worker, SPA, D1, Queue, DLQ e Cron. A credencial limitada só será solicitada ao instalar o primeiro plugin.",
  privacy: "Privacidade e confiança",
  privacyBody:
    "A Techify não recebe sua senha e não armazena seus tokens. A autorização temporária passa pelo instalador e é revogada ao final.",
  source: "Ver código-fonte",
  connecting: "Conectando sua conta Cloudflare…",
  configTitle: "Escolha a conta e o endereço",
  account: "Conta Cloudflare",
  displayName: "Nome da instalação",
  workersDev: "Endereço workers.dev automático",
  customDomain: "Domínio existente na Cloudflare",
  workersDevDetail: "HTTPS gerenciado pela Cloudflare",
  customDomainDetail: "DNS e TLS gerenciados pela Cloudflare",
  zone: "Zona",
  prefix: "Prefixo",
  continue: "Continuar",
  reviewTitle: "Revise a instalação",
  reviewBody:
    "A Cloudflare poderá contabilizar o uso conforme o plano desta conta. Nenhum recurso será criado antes da confirmação.",
  release: "Release",
  resources: "Recursos",
  address: "Endereço",
  back: "Voltar",
  install: "Instalar Nexus Edge",
  progressTitle: "Instalando seu Nexus Edge",
  progressBody:
    "Você pode fechar esta aba e voltar pela mesma URL enquanto a sessão estiver ativa.",
  pending: "Pendente",
  running: "Em andamento",
  done: "Concluída",
  failed: "Falhou",
  retry: "Tentar novamente",
  reconnect: "Conectar novamente à Cloudflare",
  cancel: "Cancelar instalação",
  successTitle: "Seu Nexus Edge foi criado",
  successBody:
    "A autorização temporária foi encerrada. Agora crie o primeiro administrador diretamente no seu Nexus.",
  createAdmin: "Criar primeiro administrador",
  downloadReport: "Baixar relatório técnico",
  requestId: "Identificador de suporte",
  genericError: "Não foi possível concluir esta etapa.",
  d1LimitMessage: "Esta conta atingiu o limite de bancos D1 da Cloudflare.",
  d1LimitSteps:
    "Abra o painel D1, exclua somente um banco nexus-edge de teste que você tenha certeza de que não está em uso, volte para esta aba e use o botão azul para continuar.",
  openD1Dashboard: "Abrir bancos D1 na Cloudflare",
  select: "Selecione",
  loading: "Carregando…",
  worker: "Worker",
  database: "D1",
  queue: "Queue",
  dlq: "Dead Letter Queue",
  stagePreflight: "Verificando permissões",
  stageRelease: "Validando release assinada",
  stageDatabase: "Criando banco D1",
  stageMigrations: "Aplicando migrations",
  stageQueues: "Criando filas",
  stageCredential: "Preparando o Core Worker",
  stageWorker: "Enviando Worker e interface",
  stageCron: "Configurando Cron e consumidor",
  stageDomain: "Configurando endereço",
  stageHealth: "Testando a instalação",
  stageRevoke: "Encerrando autorização temporária",
} as const;

type TranslationKey = keyof typeof pt;
const en: Record<TranslationKey, string> = {
  brand: "Nexus Edge",
  installer: "Cloudflare Installer",
  language: "Português",
  eyebrow: "Cloudflare native",
  introTitle: "Your Nexus, in your own Cloudflare account",
  introBody:
    "Create the Worker, D1 database, queues, and schedules without GitHub, Node.js, or Wrangler on your computer.",
  signIn: "Sign in with Cloudflare",
  creates: "What will be created",
  createsBody:
    "Core Worker, SPA, D1, Queue, DLQ, and Cron. The limited credential is requested only when the first plugin is installed.",
  privacy: "Privacy and trust",
  privacyBody:
    "Techify never receives your password or stores your tokens. Temporary authorization passes through the installer and is revoked at the end.",
  source: "View source code",
  connecting: "Connecting your Cloudflare account…",
  configTitle: "Choose the account and address",
  account: "Cloudflare account",
  displayName: "Installation name",
  workersDev: "Automatic workers.dev address",
  customDomain: "Existing Cloudflare domain",
  workersDevDetail: "HTTPS managed by Cloudflare",
  customDomainDetail: "DNS and TLS managed by Cloudflare",
  zone: "Zone",
  prefix: "Prefix",
  continue: "Continue",
  reviewTitle: "Review the installation",
  reviewBody:
    "Cloudflare may account for usage under this account's plan. No resource is created before confirmation.",
  release: "Release",
  resources: "Resources",
  address: "Address",
  back: "Back",
  install: "Install Nexus Edge",
  progressTitle: "Installing your Nexus Edge",
  progressBody:
    "You may close this tab and return to the same URL while the session is active.",
  pending: "Pending",
  running: "Running",
  done: "Completed",
  failed: "Failed",
  retry: "Try again",
  reconnect: "Reconnect Cloudflare",
  cancel: "Cancel installation",
  successTitle: "Your Nexus Edge is ready",
  successBody:
    "Temporary authorization has ended. Now create the first administrator directly in your Nexus.",
  createAdmin: "Create first administrator",
  downloadReport: "Download technical report",
  requestId: "Support identifier",
  genericError: "This step could not be completed.",
  d1LimitMessage: "This account has reached its Cloudflare D1 database limit.",
  d1LimitSteps:
    "Open the D1 dashboard, delete only an unused nexus-edge test database, return to this tab, and use the blue button to continue.",
  openD1Dashboard: "Open Cloudflare D1 databases",
  select: "Select",
  loading: "Loading…",
  worker: "Worker",
  database: "D1",
  queue: "Queue",
  dlq: "Dead Letter Queue",
  stagePreflight: "Checking permissions",
  stageRelease: "Validating signed release",
  stageDatabase: "Creating D1 database",
  stageMigrations: "Applying migrations",
  stageQueues: "Creating queues",
  stageCredential: "Preparing the Core Worker",
  stageWorker: "Uploading Worker and interface",
  stageCron: "Configuring Cron and consumer",
  stageDomain: "Configuring address",
  stageHealth: "Testing the installation",
  stageRevoke: "Ending temporary authorization",
};

const storageKey = "nexus.installer.language";
function initialLocale(): Locale {
  const stored = localStorage.getItem(storageKey);
  if (stored === "pt-BR" || stored === "en") return stored;
  return navigator.languages.some((locale) =>
    locale.toLowerCase().startsWith("en"),
  )
    ? "en"
    : "pt-BR";
}

export function useI18n() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem(storageKey, locale);
  }, [locale]);
  return {
    locale,
    t: (key: TranslationKey): string => (locale === "pt-BR" ? pt : en)[key],
    toggle: (): void =>
      setLocale((value) => (value === "pt-BR" ? "en" : "pt-BR")),
  };
}
