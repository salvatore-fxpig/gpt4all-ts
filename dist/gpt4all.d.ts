/// <reference types="node" />
import { Readable } from 'stream';
export declare class GPT4All {
    private bot;
    private model;
    private decoderConfig;
    private executablePath;
    private modelPath;
    private basePath;
    constructor(model?: string, decoderConfig?: Record<string, any>, basePath?: string);
    init(forceDownload?: boolean): Promise<void>;
    open(): Promise<void>;
    close(): void;
    private downloadExecutable;
    private downloadModel;
    private downloadFile;
    prompt(prompt: string): Readable & Promise<string>;
}
