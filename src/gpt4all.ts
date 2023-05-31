import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import axios from 'axios';
import * as ProgressBar from 'progress';
import { Readable } from 'stream'

export class GPT4All {
    private bot: ReturnType<typeof spawn> | null = null;
    private model: string;
    private decoderConfig: Record<string, any>;
    private executablePath: string;
    private modelPath: string;
    private basePath: string;

    constructor(model: string = 'gpt4all-lora-quantized', decoderConfig: Record<string, any> = {}, basePath = `${os.homedir()}/.nomic`) {
        this.model = model;
        this.decoderConfig = decoderConfig;
        /* 
        allowed models: 
        M1 Mac/OSX: cd chat;./gpt4all-lora-quantized-OSX-m1
    Linux: cd chat;./gpt4all-lora-quantized-linux-x86
    Windows (PowerShell): cd chat;./gpt4all-lora-quantized-win64.exe
    Intel Mac/OSX: cd chat;./gpt4all-lora-quantized-OSX-intel
        */
        if (
            'gpt4all-lora-quantized' !== model &&
            'gpt4all-lora-unfiltered-quantized' !== model
        ) {
            throw new Error(`Model ${model} is not supported. Current models supported are: 
                gpt4all-lora-quantized
                gpt4all-lora-unfiltered-quantized`
            );
        }

        this.basePath = basePath;
        this.executablePath = `${basePath}/gpt4all`;
        this.modelPath = `${basePath}/${model}.bin`;
    }

    async init(forceDownload: boolean = false): Promise<void> {
        const downloadPromises: Promise<void>[] = [];

        if (forceDownload || !fs.existsSync(this.executablePath)) {
            downloadPromises.push(this.downloadExecutable());
        }

        if (forceDownload || !fs.existsSync(this.modelPath)) {
            downloadPromises.push(this.downloadModel());
        }

        await Promise.all(downloadPromises);
    }

    public async open(): Promise<void> {
        if (this.bot !== null) {
            this.close();
        }

        let spawnArgs = [this.executablePath, '--model', this.modelPath];

        for (let [key, value] of Object.entries(this.decoderConfig)) {
            spawnArgs.push(`--${key}`, value.toString());
        }

        this.bot = spawn(spawnArgs[0], spawnArgs.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
        // wait for the bot to be ready
        await new Promise((resolve) => {
            this.bot?.stdout?.on('data', (data) => {
                if (data.toString().includes('>')) {
                    resolve(true);
                }
            });
        });
    }

    public close(): void {
        if (this.bot !== null) {
            this.bot.kill();
            this.bot = null;
        }
    }

    private async downloadExecutable(): Promise<void> {
        console.log("downloading executable")

        let upstream: string;
        const platform = os.platform();

        if (platform === 'darwin') {
            // check for M1 Mac
            const { stdout } = await promisify(exec)('uname -m');
            if (stdout.trim() === 'arm64') {
                upstream = 'https://github.com/nomic-ai/gpt4all/blob/main/chat/gpt4all-lora-quantized-OSX-m1?raw=true';
            } else {
                upstream = 'https://github.com/nomic-ai/gpt4all/blob/main/chat/gpt4all-lora-quantized-OSX-intel?raw=true';
            }
        }
        else if (platform === 'linux') {
            upstream = 'https://github.com/nomic-ai/gpt4all/blob/main/chat/gpt4all-lora-quantized-linux-x86?raw=true';
        }
        else if (platform === 'win32') {
            upstream = 'https://github.com/nomic-ai/gpt4all/blob/main/chat/gpt4all-lora-quantized-win64.exe?raw=true';
        }
        else {
            throw new Error(`Your platform is not supported: ${platform}. Current binaries supported are for OSX (ARM and Intel), Linux and Windows.`);
        }

        await this.downloadFile(upstream, this.executablePath);

        await fs.promises.chmod(this.executablePath, 0o755);

        console.log(`File downloaded successfully to ${this.executablePath}`);
    }

    private async downloadModel(): Promise<void> {
        console.log("downloading model")

        const modelUrl = `https://the-eye.eu/public/AI/models/nomic-ai/gpt4all/${this.model}.bin`;

        await this.downloadFile(modelUrl, this.modelPath);

        console.log(`File downloaded successfully to ${this.modelPath}`);
    }

    private async downloadFile(url: string, destination: string): Promise<void> {
        const { data, headers } = await axios.get(url, { responseType: 'stream' });
        const totalSize = parseInt(headers['content-length'], 10);
        const progressBar = new ProgressBar('[:bar] :percent :etas', {
            complete: '=',
            incomplete: ' ',
            width: 20,
            total: totalSize,
        });
        const dir = new URL(`file://${this.basePath}/`)
        await fs.promises.mkdir(dir, { recursive: true });

        let totalProgress = 0
        const updateProgress = (addSize: number) => {
            const newProgress = totalProgress + addSize;
            const pct = (newProgress / totalSize).toFixed(1)
            if (pct != (totalProgress / totalSize).toFixed(1))
                console.log(`${+pct * 100}% done`)
            totalProgress = newProgress
        }

        const writer = fs.createWriteStream(destination);

        data.on('data', (chunk: any) => {
            progressBar.tick(chunk.length);
            updateProgress(chunk.length)
        });

        data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    }

    public prompt(prompt: string): Readable & Promise<string> {
        if (this.bot === null) {
            throw new Error("Bot is not initialized.");
        }

        this.bot.stdin.write(prompt + "\n");

        const buffer: string[] = []
        let finished = false
        let errored = false
        const stream = new Readable({
            async read() {
                if (errored) return this.push(null)
                if (finished && !buffer.length) return this.push(null)
                while (!buffer.length) await new Promise(resolve => setTimeout(resolve, 50))
                this.push(buffer.shift())
            }
        });

        const promise = new Promise<string>((resolve, reject) => {
            let response: string = "";
            let timeoutId: NodeJS.Timeout;

            const onStdoutData = (data: Buffer) => {
                const text = data.toString();
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }

                if (text.includes(">")) {
                    // console.log('Response starts with >, end of message - Resolving...'); // Debug log: Indicate that the response ends with "\\f"
                    terminateAndResolve(response); // Remove the trailing "\f" delimiter
                } else {
                    timeoutId = setTimeout(() => {
                        // console.log('Timeout reached - Resolving...'); // Debug log: Indicate that the timeout has been reached
                        terminateAndResolve(response);
                    }, 4000); // Set a timeout of 4000ms to wait for more data
                }
                // console.log('Received text:', text); // Debug log: Show the received text
                buffer.push(text)
                // console.log(stream.readable)
                // if (!stream.readable) {
                //     stream.emit("readable")
                //     stream.readable = true;
                // }
                response += text;
                // console.log('Updated response:', response); // Debug log: Show the updated response

            };

            const onStdoutError = (err: Error) => {
                this.bot.stdout.removeListener("data", onStdoutData);
                this.bot.stdout.removeListener("error", onStdoutError);
                stream.emit("error", err)
                finished = true;
                reject(err);
            };

            const terminateAndResolve = (finalResponse: string) => {
                this.bot.stdout.removeListener("data", onStdoutData);
                this.bot.stdout.removeListener("error", onStdoutError);
                finished = true;
                // check for > at the end and remove it
                if (finalResponse.endsWith(">")) {
                    finalResponse = finalResponse.slice(0, -1);
                }
                resolve(finalResponse);
            };

            this.bot.stdout.on("data", onStdoutData);
            this.bot.stdout.on("error", onStdoutError);
        });

        return Object.assign(stream, promise);
    }
}
