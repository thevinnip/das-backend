import RealBrowser from "puppeteer-real-browser"
import "colors";
import axios from "axios";
import {load} from "cheerio";
import * as fs from "node:fs";
import zlib from "node:zlib";
import {wrapper} from "axios-cookiejar-support";
import {CookieJar} from "tough-cookie";
import archiver from 'archiver';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import cors from 'cors';

import express, { Request, Response } from "express";
import http from "http";
import SocketIO, {Server} from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Configuração do CORS
app.use(cors({
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
}));

app.use(express.json());

let browser: { close(): Promise<void> } | null = null;

interface TaskProgress {
  cnpj: string;
  nome: string;
  status: 'pending' | 'processing' | 'completed' | 'error';
  error?: string;
}

interface Task {
    id: string;
    status: 'pending' | 'processing' | 'completed' | 'error';
    cnpjs: string[];
    referenceMonth: string;
    startDate: Date;
    endDate?: Date;
    error?: string;
    progress: TaskProgress[];
    totalProcessed: number;
    totalSuccess: number;
    totalError: number;
}

const tasks: Map<string, Task> = new Map();

const PORT = Number(process.env.PORT ?? 4031);
const CAPTCHA_PUBLIC_ORIGIN =
    process.env.CAPTCHA_PUBLIC_ORIGIN ?? `http://127.0.0.1:${PORT}`;

function getCaptchaHtml(): string {
    const template = fs.readFileSync(path.join(__dirname, "html.html"), "utf8");
    return template.split("__CAPTCHA_ORIGIN__").join(CAPTCHA_PUBLIC_ORIGIN);
}

function createPgmeiClient() {
    return wrapper(
        axios.create({
            headers: {
                Priority: "u=0, i",
                "Accept-Encoding": "gzip, deflate, br",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-User": "?1",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "cross-site",
                "Accept-Language": "pt-BR,pt;q=0.9",
                "Sec-Gpc": "1",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Ch-Ua-Platform": '"Windows"',
                "Sec-Ch-Ua-Mobile": "?0",
                "Sec-Ch-Ua": '"Brave";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
                Connection: "keep-alive",
                "X-Real-Ip": "177.10.117.235",
                Host: "www8.receita.fazenda.gov.br",
                Origin: "https://www8.receita.fazenda.gov.br",
            },
            jar: new CookieJar(),
            withCredentials: true,
            maxRedirects: 5,
        })
    );
}

app.get("/", async (req, res) => {
    res.type("html").send(getCaptchaHtml());
});

app.post("/process-cnpjs", async (req: Request, res: Response): Promise<any> => {
    const { cnpjs, referenceMonth } = req.body;

    if (!cnpjs || !Array.isArray(cnpjs) || cnpjs.length === 0) {
        return res.status(400).json({ error: "Lista de CNPJs inválida" });
    }

    if (!referenceMonth || !/^\d{2}\/\d{4}$/.test(referenceMonth)) {
        return res.status(400).json({ error: "Mês de referência inválido. Use o formato MM/YYYY" });
    }

    const taskId = uuidv4();
    const task: Task = {
        id: taskId,
        status: 'pending',
        cnpjs,
        referenceMonth,
        startDate: new Date(),
        progress: cnpjs.map(cnpj => ({
            cnpj,
            nome: '',
            status: 'pending'
        })),
        totalProcessed: 0,
        totalSuccess: 0,
        totalError: 0
    };

    tasks.set(taskId, task);

    res.json({ 
        message: "Processamento iniciado", 
        taskId,
        totalCnpjs: cnpjs.length 
    });

    // Iniciar processamento
    processCnpjs(cnpjs, new Date(parseInt(referenceMonth.split('/')[1]), parseInt(referenceMonth.split('/')[0]) - 1, 1), taskId);
});

app.get("/task/:taskId", (req: Request, res: Response): any => {
const taskId = Array.isArray(req.params.taskId)
  ? req.params.taskId[0]
  : req.params.taskId;

const task = tasks.get(taskId);
    if (!task) {
        return res.status(404).json({ error: "Task não encontrada" });
    }
    res.json(task);
});

app.get("/download/:taskId", async (req: Request, res: Response): Promise<any> => {
const taskId = Array.isArray(req.params.taskId)
  ? req.params.taskId[0]
  : req.params.taskId;

const task = tasks.get(taskId);
    if (!task) {
        return res.status(404).json({ error: "Task não encontrada" });
    }

    if (task.status !== 'completed') {
        return res.status(400).json({ error: "Task ainda não foi concluída" });
    }

    const zipPath = path.join(__dirname, 'zips', `${task.id}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

   output.on('close', () => {
    res.download(
        zipPath,
        `das_${task.referenceMonth.replace('/', '_')}.zip`,
        (err) => {
            if (err) {
                console.error('Erro ao enviar arquivo:', err);
            }

            fs.unlink(zipPath, (err) => {
                if (err) {
                    console.error('Erro ao deletar arquivo:', err);
                }
            });
        }
    );
});

    archive.on('error', (err: Error) => {
        res.status(500).json({ error: "Erro ao criar arquivo ZIP" });
    });

    archive.pipe(output);

    // Adicionar apenas os PDFs relacionados à task
    const dasDir = path.join(__dirname, 'das');
    const files = fs.readdirSync(dasDir);
    
    // Filtrar apenas os arquivos que correspondem aos CNPJs da task
    const taskFiles = files.filter(file => {
        const fileCnpj = file.split('_').pop()?.replace('.pdf', '');
        return task.progress.some(progress => 
            progress.cnpj.replace(/\D/g, '') === fileCnpj
        );
    });

    for (const file of taskFiles) {
        const filePath = path.join(dasDir, file);
        const header = fs.readFileSync(filePath).subarray(0, 5).toString("latin1");
        if (header !== "%PDF-") {
            continue;
        }
        archive.file(filePath, { name: file });
    }

    await archive.finalize();
});

let connectedSockets: SocketIO.Socket[] = [];
let captchaTokens = [] as string[];

io.on("connection", (socket) => {
    console.log("a user connected");
    connectedSockets.push(socket);
    socket.on('get-captcha', (captcha: string) => {
        captchaTokens.push(captcha);
    })
    socket.on("disconnect", () => {
        console.log("user disconnected");
        connectedSockets = connectedSockets.filter(s => s !== socket);
    });
});

function sanitizeFileName(fileName: string): string {
    // Remove caracteres especiais e espaços, mantendo apenas letras, números e alguns caracteres seguros
    return fileName
        .replace(/[^a-zA-Z0-9\s-]/g, '_') // Substitui caracteres especiais por _
        .replace(/\s+/g, '_') // Substitui espaços por _
        .replace(/_+/g, '_') // Remove underscores duplicados
        .replace(/^_|_$/g, ''); // Remove underscores do início e fim
}

async function readResponseBody(data: unknown): Promise<Buffer> {
    if (Buffer.isBuffer(data)) {
        return data;
    }

    if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
    }

    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }

    if (typeof data === "string") {
        return Buffer.from(data, "latin1");
    }

    if (data && typeof (data as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
        const chunks: Buffer[] = [];
        for await (const chunk of data as AsyncIterable<unknown>) {
            if (Buffer.isBuffer(chunk)) {
                chunks.push(chunk);
            } else if (chunk instanceof ArrayBuffer) {
                chunks.push(Buffer.from(chunk));
            } else if (ArrayBuffer.isView(chunk)) {
                chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            } else if (typeof chunk === "string") {
                chunks.push(Buffer.from(chunk, "latin1"));
            } else {
                throw new Error("Trecho do PDF em formato inesperado");
            }
        }
        return Buffer.concat(chunks);
    }

    throw new Error("Resposta do PDF em formato inesperado");
}

function isTrailingJunk(tail: Buffer): boolean {
    if (tail.length === 0) return false;
    for (const byte of tail) {
        if (byte !== 0 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 32) {
            return false;
        }
    }
    return true;
}

function normalizePdfBuffer(input: Buffer): Buffer | null {
    let buffer = input;

    if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
        try {
            buffer = zlib.gunzipSync(buffer);
        } catch {
            return null;
        }
    }

    const head = buffer.subarray(0, 32).toString("utf8").trimStart();
    if (head.startsWith("JVBERi0")) {
        try {
            const decoded = Buffer.from(buffer.toString("utf8").replace(/\s/g, ""), "base64");
            if (decoded.subarray(0, 5).toString("latin1") !== "%PDF-") {
                return null;
            }
            buffer = decoded;
        } catch {
            return null;
        }
    }

    const marker = buffer.indexOf("%PDF-");
    if (marker < 0 || marker > 512) {
        return null;
    }
    if (marker > 0) {
        buffer = buffer.subarray(marker);
    }

    const eof = buffer.lastIndexOf("%%EOF");
    if (eof !== -1) {
        let end = eof + 5;
        if (buffer[end] === 0x0d) end += 1;
        if (buffer[end] === 0x0a) end += 1;
        if (isTrailingJunk(buffer.subarray(end))) {
            buffer = buffer.subarray(0, end);
        }
    }

    if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
        return null;
    }

    return buffer;
}

function absolutePgmeiUrl(action: string): string {
    if (action.startsWith("http")) return action;
    const base = "https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app";
    return action.startsWith("/")
        ? `https://www8.receita.fazenda.gov.br${action}`
        : `${base}/${action.replace(/^\//, "")}`;
}

async function fetchDasPdf(
    client: ReturnType<typeof createPgmeiClient>,
    dasGenerationHtml: string
): Promise<Buffer | null> {
    const $ = load(dasGenerationHtml);
    const printForm = $('form[action*="imprimir"]').first();
    const referer =
        "https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao/gerarDas";
    const pdfHeaders = {
        Accept: "application/pdf,application/octet-stream,*/*;q=0.8",
        "Accept-Encoding": "identity",
        Referer: referer,
    };

    const attempts: Array<() => Promise<Buffer>> = [];

    if (printForm.length) {
        const action = printForm.attr("action");
        if (action) {
            const url = absolutePgmeiUrl(action);
            const body = new URLSearchParams();
            printForm.find("input").each((_, element) => {
                const name = $(element).attr("name");
                if (!name) return;
                body.append(name, $(element).attr("value") ?? "");
            });
            attempts.push(async () =>
                readResponseBody(
                    (
                        await client.post(url, body.toString(), {
                            responseType: "stream",
                            decompress: true,
                            timeout: 60000,
                            headers: {
                                ...pdfHeaders,
                                "Content-Type": "application/x-www-form-urlencoded",
                            },
                        })
                    ).data
                )
            );
        }
    }

    attempts.push(async () =>
        readResponseBody(
            (
                await client.get(
                    "https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao/imprimir",
                    {
                        responseType: "stream",
                        decompress: true,
                        timeout: 60000,
                        headers: pdfHeaders,
                    }
                )
            ).data
        )
    );

    for (const attempt of attempts) {
        try {
            const rawPdf = await attempt();
            const pdfBuffer = normalizePdfBuffer(rawPdf);
            if (pdfBuffer) return pdfBuffer;
        } catch {
            // tenta o próximo método
        }
    }

    return null;
}

async function waitForCaptchaSocket(timeoutMs = 120000): Promise<SocketIO.Socket> {
    const started = Date.now();
    while (connectedSockets.length === 0) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(
                "Navegador do captcha não conectou. Verifique se a janela do Chrome abriu e se CAPTCHA_PUBLIC_ORIGIN está correto."
            );
        }
        await delay(500);
    }

    return connectedSockets[connectedSockets.length - 1];
}

function loginSucceeded(html: string): boolean {
    return (
        html.includes("<strong>CNPJ:</strong>") ||
        html.includes("/pgmei.app/Home/inicio") ||
        html.includes("/pgmei.app/emissao")
    );
}

async function requestCaptchaToken(): Promise<string> {
    const socket = await waitForCaptchaSocket();
    captchaTokens.length = 0;
    const started = Date.now();

    return new Promise<string>((resolve, reject) => {
        const interval = setInterval(() => {
            const token = captchaTokens.shift();
            if (token) {
                clearInterval(interval);
                resolve(token);
                return;
            }

            if (Date.now() - started > 120000) {
                clearInterval(interval);
                reject(new Error("Timeout aguardando resposta do captcha"));
            }
        }, 250);

        socket.emit("get-captcha");
    });
}

async function processCnpjs(cnpjList: string[], referenceDate: Date, taskId: string) {
    console.log(cnpjList)
    const task = tasks.get(taskId);
    if (!task) return;

    task.status = 'processing';
    tasks.set(taskId, task);

    console.log(`
         █████╗ ███████╗███████╗██╗███╗   ███╗███████╗██╗
        ██╔══██╗██╔════╝██╔════╝██║████╗ ████║██╔════╝██║
        ███████║███████╗███████╗██║██╔████╔██║█████╗  ██║
        ██╔══██║╚════██║╚════██║██║██║╚██╔╝██║██╔══╝  ██║
        ██║  ██║███████║███████║██║██║ ╚═╝ ██║███████╗██║
        ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝╚═╝     ╚═╝╚══════╝╚═╝
    `.blue)

    const start = Date.now();

    if (!fs.existsSync("files")) {
        fs.mkdirSync("files");
    }

    if (!fs.existsSync("das")) {
        fs.mkdirSync("das");
    }

    console.log(`Iniciando processamento de ${cnpjList.length} CNPJs`.blue)

    for (const cnpj of cnpjList) {
        const client = createPgmeiClient();
        const numberedCNPJ = cnpj.replace(/\D/g, '');
        const progressIndex = task.progress.findIndex(p => p.cnpj === cnpj);
        
        if (!validarCNPJ(numberedCNPJ)) {
            console.log(`[ERRO] CNPJ ${cnpj} inválido`.red);
            fs.appendFileSync("files/error.txt", `${cnpj} - Inválido\n`);
            
            if (progressIndex !== -1) {
                task.progress[progressIndex].status = 'error';
                task.progress[progressIndex].error = 'CNPJ inválido';
                task.totalError++;
            }
            
            task.totalProcessed++;
            tasks.set(taskId, task);
            continue;
        }

        try {
            if (progressIndex !== -1) {
                task.progress[progressIndex].status = 'processing';
                tasks.set(taskId, task);
            }

            const r1 = await client.get('https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao')
            // <input name="__RequestVerificationToken" type="hidden" value="Rwe2GSpDmtOGzHyThqeekFSPRxVXzwNmuFfjX3T98qGIRDH_pH_iREogM1UyxCzL6562HSiV3xM-M4oWDIiBQ_JZ1T6rf0cXBDA8ar7YAtw1">
            const loginRequestVerificationToken = r1.data.split('name="__RequestVerificationToken" type="hidden" value="')[1].split('"')[0];

            const r2 = await client.post('https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao/Continuar', new URLSearchParams({
                __RequestVerificationToken: loginRequestVerificationToken,
                cnpj: numberedCNPJ.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5"),
                "h-captcha-response": await requestCaptchaToken()
            }).toString(), {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Referer:
                        "https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao",
                }
            })

            if (typeof r2.data !== "string" || !loginSucceeded(r2.data)) {
                fs.writeFileSync(
                    path.join(__dirname, "files", `login-falha-${numberedCNPJ}.html`),
                    r2.data
                );
                throw new Error("Falha ao autenticar CNPJ (captcha ou sessão inválida)");
            }

            const start = Date.now();
            const now = new Date()
            const lastMonth = referenceDate
            const fullYear = lastMonth.getFullYear();

            const emissionResponse = await client.post(
                "https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao",
                new URLSearchParams({ ano: String(fullYear) }).toString(),
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        Referer:
                            "https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao",
                    },
                }
            );

            if (
                typeof emissionResponse.data === "string" &&
                emissionResponse.data.includes("Informe o Ano-Calendário")
            ) {
                throw new Error("Não foi possível abrir a emissão do DAS para o ano informado");
            }

            const fullMonth = (lastMonth.getMonth() + 1).toString().padStart(2, '0');
            const fullDay = lastMonth.getDate().toString().padStart(2, '0');

            const nowFullYear = now.getFullYear();
            const nowFullMonth = (now.getMonth() + 1).toString().padStart(2, '0');
            const nowFullDay = now.getDate().toString().padStart(2, '0');

            const requestVerificationToken = emissionResponse.data.split('name="__RequestVerificationToken" type="hidden" value="')[1]?.split('"')[0];
            const nomeMatch = emissionResponse.data.match(/<strong>Nome:<\/strong>\s*([^<]+)/);
            const nome = (nomeMatch?.[1] ?? "").replace(/\d/g, "").trim();

            if (!requestVerificationToken || !nome) {
                throw new Error("Resposta de emissão inválida da Receita Federal");
            }

            const pa = `${fullYear}${fullMonth}`;
            const dataConsolidacao = `${nowFullDay}/${nowFullMonth}/${nowFullYear}`;

            const validateRetificationResponse = await client.post(
                'https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Emissao/VerificaRetificacaoAutomatica',
                `ano=${fullYear}&listaPA=${pa}&aliquotaDivergente=false&valorTributoDivergente=false`,
                {
                    headers: {
                        // cookie: (await page.cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Referer': 'https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao',
                    },
                    validateStatus: () => true
                }
            );

            if (validateRetificationResponse.data !== "NO") {
                console.log(`[ERRO] CNPJ ${cnpj} possui retificação automática para o mês ${fullMonth}/${fullYear} (${((Date.now() - start) / 1000).toFixed(1)}s)`.red);
                fs.appendFileSync("error.txt", `${cnpj} - Retificação automática\n`);
                continue;
            }

            const dasGenerationResponse = await client.post(
                'https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao/gerarDas',
                `__RequestVerificationToken=${requestVerificationToken}&pa=${pa}&dataConsolidacao=${dataConsolidacao}&ano=${fullYear}`,
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        Referer:
                            "https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao",
                    },
                },
            ).catch((error: any): null => {
                console.log(`[ERRO] CNPJ ${cnpj} não possui DAS para o mês ${fullMonth}/${fullYear} (${((Date.now() - start) / 1000).toFixed(1)}s)`.red);
                fs.appendFileSync("files/error.txt", `${cnpj} - Sem DAS\n`);

                const progressIndex = task.progress.findIndex(p => p.cnpj.replace(/[\/\-]/g, '') === cnpj.replace(/[\/\-]/g, ''))
                if (progressIndex !== -1) {
                    task.progress[progressIndex].status = 'error';
                    task.progress[progressIndex].error = 'Sem DAS disponível';
                    task.progress[progressIndex].nome = nome;
                    task.totalError++;
                }

                return null
            })

            if (!dasGenerationResponse) {
                continue
            }

            const dasHtml = await load(dasGenerationResponse.data);

            const dasTable = dasHtml('table.table.table-hover.table-condensed tbody tr');
            const dasApuracaoCode = dasTable.find('td').eq(1).text().trim();

            if (!dasApuracaoCode) {
                console.log(`[ERRO] CNPJ ${cnpj} não possui DAS para o mês ${fullMonth}/${fullYear} (${((Date.now() - start) / 1000).toFixed(1)}s)`.red);
                fs.appendFileSync("files/error.txt", `${cnpj} - Sem DAS\n`);
                
                if (progressIndex !== -1) {
                    task.progress[progressIndex].status = 'error';
                    task.progress[progressIndex].error = 'Sem DAS disponível';
                    task.progress[progressIndex].nome = nome;
                    task.totalError++;
                }
            } else {
                const pdfBuffer = await fetchDasPdf(client, dasGenerationResponse.data);

                if (!pdfBuffer) {
                    console.log(`[ERRO] CNPJ ${cnpj} retornou um PDF inválido (${((Date.now() - start) / 1000).toFixed(1)}s)`.red);
                    fs.appendFileSync("files/error.txt", `${cnpj} - PDF inválido\n`);

                    if (progressIndex !== -1) {
                        task.progress[progressIndex].status = 'error';
                        task.progress[progressIndex].error = 'PDF inválido retornado pela Receita';
                        task.progress[progressIndex].nome = nome;
                        task.totalError++;
                    }
                } else {
                    const sanitizedName = sanitizeFileName(nome);
                    const fileName = `${sanitizedName}_${numberedCNPJ}.pdf`;
                    const filePath = path.join(__dirname, 'das', fileName);
                    console.log(filePath);

                    fs.writeFileSync(filePath, pdfBuffer);
                    fs.appendFileSync("files/done.txt", `${cnpj}\n`);
                    console.log(`[SUCESSO] DAS gerado para o CNPJ ${cnpj} no mês ${fullMonth}/${fullYear} (${((Date.now() - start) / 1000).toFixed(1)}s)`.green);

                    if (progressIndex !== -1) {
                        task.progress[progressIndex].status = 'completed';
                        task.progress[progressIndex].nome = nome;
                        task.totalSuccess++;
                    }
                }
            }

            task.totalProcessed++;
            tasks.set(taskId, task);

            await client.get(
                "https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/home/sair",
                { validateStatus: () => true }
            );

            // se o index for divisivel por 5, aguardar 5 segundos
            if (cnpjList.indexOf(cnpj) % 5 === 0 && cnpjList.indexOf(cnpj) !== 0) {
                // await delay(5000);
            }
        } catch (error: any) {
            console.log(`[ERRO] Erro ao processar CNPJ ${cnpj}: ${error.message}`.red);
            
            if (progressIndex !== -1) {
                task.progress[progressIndex].status = 'error';
                task.progress[progressIndex].error = error.message;
                task.totalError++;
            }
            
            task.totalProcessed++;
            tasks.set(taskId, task);
        }
    }

    task.status = 'completed';
    task.endDate = new Date();
    tasks.set(taskId, task);

    // await browser.close();
    console.log(`Fim do processamento de ${cnpjList.length} CNPJs (${((Date.now() - start) / 1000 / 60).toFixed(1)}m)\nTempo médio por CNPJ: ${((Date.now() - start) / cnpjList.length / 1000).toFixed(1)}s`.blue);
}


const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

function validarCNPJ(cnpj: string): boolean {
    cnpj = cnpj.replace(/[^\d]+/g, '');

    if (cnpj === '') return false;

    if (cnpj.length !== 14) return false;

    // Elimina CNPJs inválidos conhecidos
    const invalidCNPJs = [
        "00000000000000", "11111111111111", "22222222222222",
        "33333333333333", "44444444444444", "55555555555555",
        "66666666666666", "77777777777777", "88888888888888",
        "99999999999999"
    ];

    if (invalidCNPJs.includes(cnpj)) return false;

    // Valida DVs
    let tamanho = cnpj.length - 2;
    let numeros = cnpj.substring(0, tamanho);
    let digitos = cnpj.substring(tamanho);
    let soma = 0;
    let pos = tamanho - 7;

    for (let i = tamanho; i >= 1; i--) {
        soma += +numeros.charAt(tamanho - i) * pos--;
        if (pos < 2) pos = 9;
    }

    let resultado = soma % 11 < 2 ? 0 : 11 - soma % 11;
    if (resultado !== +digitos.charAt(0)) return false;

    tamanho = tamanho + 1;
    numeros = cnpj.substring(0, tamanho);
    soma = 0;
    pos = tamanho - 7;

    for (let i = tamanho; i >= 1; i--) {
        soma += +numeros.charAt(tamanho - i) * pos--;
        if (pos < 2) pos = 9;
    }

    resultado = soma % 11 < 2 ? 0 : 11 - soma % 11;
    if (resultado !== +digitos.charAt(1)) return false;

    return true;
}

server.listen(PORT, "0.0.0.0", async () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Captcha socket em ${CAPTCHA_PUBLIC_ORIGIN}`.cyan);
    
    // Criar pasta zips se não existir
    if (!fs.existsSync("zips")) {
        fs.mkdirSync("zips");
    }
    
    try {
        const { page, browser: captchaBrowser } = await RealBrowser.connect({
            headless: false,
            args: [
                "--disable-web-security",
                "--allow-running-insecure-content",
                "--disable-features=BlockInsecurePrivateNetworkRequests",
            ],
        } as Parameters<typeof RealBrowser.connect>[0]);
        browser = captchaBrowser as { close(): Promise<void> };

		await page.setRequestInterception(true)
		
		page.on("request", (req: { url(): string; respond(response: object): unknown; continue(overrides?: { url?: string }): unknown }) => {
			const url = req.url()
			if (url == "https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao") {
      return req.respond({
        status: 200,
        contentType: 'text/html',
        body: getCaptchaHtml(),
      });
			}
			
			  if (url.startsWith('https://www8.receita.fazenda.gov.br/socket.io/')) {
      const newUrl = url.replace(
        'https://www8.receita.fazenda.gov.br',
        CAPTCHA_PUBLIC_ORIGIN
      );

      return req.continue({ url: newUrl });
    }
			
			return req.continue()
		})
		
        await page.goto('https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao');
        
        console.log("Página do captcha aberta automaticamente");

        // Fechar o navegador quando o servidor for encerrado
        process.on('SIGINT', async () => {
            if (browser) {
                await browser.close();
            }
            process.exit();
        });
    } catch (error) {
        console.error("Erro ao abrir o navegador:", error);
    }
});
