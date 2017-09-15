/// <reference types="ws" />
/// <reference types="node" />
import * as Emitter from 'component-emitter';
import * as WS from 'ws';
import { ReadyState } from "./ReadyState";
import { BaseSocketConfig } from './BaseSocketConfig';
/**
 * Socket 接口的抽象类，定义了socket需要实现的基础功能
 */
export declare abstract class BaseSocket extends Emitter {
    /**
     * _messageID 的ID号，id从0开始。每发一条消息，该id加1
     *
     * @private
     * @memberof BaseSocket
     */
    private _messageID;
    private readonly _needDeserialize;
    /**
     * 等待发送消息的队列。key：messageID。
     */
    private readonly _queue;
    /**
     * 保存被包装的socket对象
     *
     * @type {(WebSocket|WS)}
     * @memberof BaseSocket
     */
    readonly socket: WebSocket | WS;
    /**
     * WebSocket server 的URL地址
     * 注意：如果是Server生成的Socket，则url为空字符串
     *
     * @type {string}
     * @memberof BaseSocket
     */
    readonly url: string;
    /**
     * 当前接口运行所处的平台
     *
     * @type {("browser" | "node")}
     * @memberof BaseSocket
     */
    readonly platform: "browser" | "node";
    /**
     * 连接的当前状态
     *
     * @readonly
     * @abstract
     * @type {ReadyState}
     * @memberof BaseSocket
     */
    readonly readyState: ReadyState;
    /**
     * 在缓冲队列中等待发送的数据字节数
     *
     * @readonly
     * @abstract
     * @type {number}
     * @memberof BaseSocket
     */
    readonly bufferedAmount: number;
    /**
     * @param {(WebSocket|WS)} socket 子类实例化的socket对象
     * @param {("browser" | "node")} platform 指示该接口所处的平台
     * @param {BaseSocketConfig} configs 配置
     * @memberof BaseSocket
     */
    constructor(socket: WebSocket | WS, platform: "browser" | "node", configs: BaseSocketConfig);
    /**
     * 对要发送的数据进行序列化。注意只有位于数组根下的boolean、string、number、void、Buffer才会进行二进制序列化，对象会被JSON.stringify
     * 数据格式： 元素类型 -> [元素长度] -> 元素内容
     *
     * @static
     * @memberof BaseSocket
     */
    static serialize(data: any[]): Buffer;
    /**
     * 对接收到的消息进行反序列化
     *
     * @static
     * @param {Buffer} data
     * @memberof BaseSocket
     */
    static deserialize(data: Buffer): any[];
    /**
     * 序列化消息头部。
     * 数据格式：头部长度 -> 是否是内部消息 -> 消息名称长度 -> 消息名称 -> 该消息是否需要确认收到 -> 消息id
     *
     * @private
     * @param {boolean} isInternal 是否是内部消息
     * @param {string} messageName 消息的名称
     * @param {boolean} needACK
     * @param {number} messageID
     * @returns {Buffer}
     * @memberof BaseSocket
     */
    private _serializeHeader(isInternal, messageName, needACK, messageID);
    /**
     * 反序列化头部
     * @param data 头部二进制数据
     */
    private _deserializeHeader(data);
    /**
     * 发送数据。发送失败直接抛出异常
     *
     * @param {string} messageName 消息的名称(标题)
     * @param {(any[] | Buffer)} [data] 要发送的数据。如果是传入的是数组，则数据将使用BaseSocket.serialize() 进行序列化。如果传入的是Buffer，则将直接被发送。如果只发送messageName，也可以留空。
     * @param {boolean} [needACK=true] 发出的这条消息是否需要确认对方是否已经收到
     * @returns {Promise<number>} messageID
     * @memberof BaseSocket
     */
    send(messageName: string, data?: any[] | Buffer, needACK?: boolean): Promise<number>;
    /**
      * 发送内部数据。发送失败直接抛出异常。
      * 注意：要在每一个调用的地方做好异常处理
      */
    protected _sendInternal(messageName: string, data?: any[] | Buffer, needACK?: boolean): Promise<number>;
    private _send(isInternal, messageName, needACK, data?);
    /**
     * 需要子类覆写。调用_socket发送数据
     *
     * @protected
     * @abstract
     * @param {Buffer} data 要发送的数据
     * @returns {Promise<void>}
     * @memberof BaseSocket
     */
    protected abstract _sendData(data: Buffer): Promise<void>;
    /**
     * 解析接收到数据。子类接收到消息后需要触发这个方法
     *
     * @private
     * @param {Buffer} data 接收到数据
     * @memberof BaseSocket
     */
    protected _receiveData(data: Buffer): void;
    /**
     * 关闭接口。关闭之后会触发close事件
     *
     * @abstract
     * @returns {void}
     * @memberof BaseSocket
     */
    abstract close(): void;
    on(event: 'error', cb: (err: Error) => void): this;
    /**
     * 当收到消息
     */
    on(event: 'message', cb: (messageName: string, data: any[] | Buffer) => void): this;
    /**
     * 当连接建立
     */
    on(event: 'open', cb: () => void): this;
    /**
     * 断开连接
     */
    on(event: 'close', cb: (code: number, reason: string) => void): this;
    once(event: 'error', cb: (err: Error) => void): this;
    /**
     * 当收到消息
     */
    once(event: 'message', cb: (messageName: string, data: any[] | Buffer) => void): this;
    /**
     * 当连接建立
     */
    once(event: 'open', cb: () => void): this;
    once(event: 'close', cb: (code: number, reason: string) => void): this;
}