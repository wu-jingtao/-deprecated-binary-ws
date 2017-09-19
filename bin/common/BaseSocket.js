"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Emitter = require("component-emitter");
const _Buffer = Buffer ? Buffer : require('buffer/').Buffer; // 确保浏览器下也能使用Buffer
const isBuffer = require('is-buffer');
/**
 * Socket 接口的抽象类，定义了socket需要实现的基础功能
 */
class BaseSocket extends Emitter {
    /**
     * @param {("browser" | "node")} platform 指示该接口所处的平台
     * @param {BaseSocketConfig} configs 配置
     * @memberof BaseSocket
     */
    constructor(platform, configs) {
        super();
        /**
         * _messageID 的ID号，id从0开始。每发一条消息，该id加1
         *
         * @private
         * @memberof BaseSocket
         */
        this._messageID = 0;
        /**
         * 等待发送消息的队列。key：messageID。
         */
        this._queue = new Map();
        this.url = configs.url;
        this._needDeserialize = configs.needDeserialize === undefined ? true : configs.needDeserialize;
        this._maxPayload = configs.maxPayload;
        this.platform = platform;
        if (configs.socket === undefined) {
            throw new Error('传入的socket不可以为空');
        }
        else {
            this.socket = configs.socket;
        }
        this.on('close', () => {
            for (let item of [...this._queue.values()].reverse()) {
                const result = item.cancel(new Error('连接中断'));
                if (result === false)
                    item.ack(new Error('连接中断')); //取消正在发送的
            }
        });
    }
    /**
     * 连接的当前状态
     *
     * @readonly
     * @abstract
     * @type {ReadyState}
     * @memberof BaseSocket
     */
    get readyState() {
        return this.socket.readyState;
    }
    /**
     * 在缓冲队列中等待发送的数据字节数
     *
     * @readonly
     * @abstract
     * @type {number}
     * @memberof BaseSocket
     */
    get bufferedAmount() {
        let size = 0;
        for (let item of this._queue.values()) {
            size += item.data.length;
        }
        return size;
    }
    /**
     * 对要发送的数据进行序列化。注意只有位于数组根下的boolean、string、number、void、Buffer才会进行二进制序列化，对象会被JSON.stringify
     * 数据格式： 元素类型 -> [元素长度] -> 元素内容
     *
     * @static
     * @memberof BaseSocket
     */
    static serialize(data) {
        const bufferItems = [];
        for (let item of data) {
            switch (typeof item) {
                case 'number': {
                    const type = _Buffer.alloc(1);
                    const content = _Buffer.alloc(8);
                    type.writeUInt8(0 /* number */, 0);
                    content.writeDoubleBE(item, 0);
                    bufferItems.push(type, content);
                    break;
                }
                case 'string': {
                    const type = _Buffer.alloc(1);
                    const content = _Buffer.from(item);
                    const contentLength = _Buffer.alloc(8);
                    type.writeUInt8(1 /* string */, 0);
                    contentLength.writeDoubleBE(content.length, 0);
                    bufferItems.push(type, contentLength, content);
                    break;
                }
                case 'boolean': {
                    const type = _Buffer.alloc(1);
                    const content = _Buffer.alloc(1);
                    type.writeUInt8(2 /* boolean */, 0);
                    content.writeUInt8(item ? 1 : 0, 0);
                    bufferItems.push(type, content);
                    break;
                }
                case 'undefined': {
                    const type = _Buffer.alloc(1);
                    type.writeUInt8(4 /* undefined */, 0);
                    bufferItems.push(type);
                    break;
                }
                case 'object': {
                    if (item === null) {
                        const type = _Buffer.alloc(1);
                        type.writeUInt8(3 /* null */, 0);
                        bufferItems.push(type);
                    }
                    else if (isBuffer(item)) {
                        const type = _Buffer.alloc(1);
                        const content = item;
                        const contentLength = _Buffer.alloc(8);
                        type.writeUInt8(6 /* Buffer */, 0);
                        contentLength.writeDoubleBE(content.length, 0);
                        bufferItems.push(type, contentLength, content);
                    }
                    else {
                        const type = _Buffer.alloc(1);
                        const content = _Buffer.from(JSON.stringify(item));
                        const contentLength = _Buffer.alloc(8);
                        type.writeUInt8(5 /* Object */, 0);
                        contentLength.writeDoubleBE(content.length, 0);
                        bufferItems.push(type, contentLength, content);
                    }
                }
            }
        }
        const result = _Buffer.concat(bufferItems);
        result._serialized = true; //标记这份数据是被序列化过了的
        return result;
    }
    /**
     * 对接收到的消息进行反序列化
     *
     * @static
     * @param {Buffer} data
     * @memberof BaseSocket
     */
    static deserialize(data) {
        if (!isBuffer(data))
            throw new Error('传入的数据类型不是Buffer');
        let previous = 0;
        const result = [];
        while (previous < data.length) {
            const type = data.readUInt8(previous++);
            switch (type) {
                case 0 /* number */: {
                    result.push(data.readDoubleBE(previous));
                    previous += 8;
                    break;
                }
                case 1 /* string */: {
                    const length = data.readDoubleBE(previous);
                    previous += 8;
                    const content = data.slice(previous, previous += length);
                    result.push(content.toString());
                    break;
                }
                case 2 /* boolean */: {
                    const content = data.readUInt8(previous++);
                    result.push(content === 1);
                    break;
                }
                case 4 /* undefined */: {
                    result.push(undefined);
                    break;
                }
                case 3 /* null */: {
                    result.push(null);
                    break;
                }
                case 6 /* Buffer */: {
                    const length = data.readDoubleBE(previous);
                    previous += 8;
                    result.push(data.slice(previous, previous += length));
                    break;
                }
                case 5 /* Object */: {
                    const length = data.readDoubleBE(previous);
                    previous += 8;
                    const content = data.slice(previous, previous += length);
                    result.push(JSON.parse(content.toString()));
                    break;
                }
                default: {
                    throw new Error('data type don`t exist. type: ' + type);
                }
            }
        }
        return result;
    }
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
    _serializeHeader(isInternal, messageName, needACK, messageID) {
        let _headerLength = _Buffer.alloc(8);
        let _isInternal = _Buffer.alloc(1);
        let _messageNameLength = _Buffer.alloc(8);
        let _messageName = _Buffer.from(messageName);
        let _needACK = _Buffer.alloc(1);
        let _messageID = _Buffer.alloc(8);
        _isInternal.writeUInt8(isInternal ? 1 : 0, 0);
        _messageNameLength.writeDoubleBE(_messageName.length, 0);
        _needACK.writeUInt8(needACK ? 1 : 0, 0);
        _messageID.writeDoubleBE(messageID, 0);
        let length = _headerLength.length + _isInternal.length + _messageName.length + _messageNameLength.length + _needACK.length + _messageID.length;
        _headerLength.writeDoubleBE(length, 0);
        return Buffer.concat([_headerLength, _isInternal, _messageNameLength, _messageName, _needACK, _messageID], length);
    }
    /**
     * 反序列化头部
     * @param data 头部二进制数据
     */
    _deserializeHeader(data) {
        if (!isBuffer(data))
            throw new Error('传入的数据类型不是Buffer');
        const header = {
            isInternal: true,
            messageName: '',
            needACK: false,
            messageID: -1,
            headerLength: 0
        };
        header.headerLength = data.readDoubleBE(0);
        let index = 8;
        header.isInternal = data.readUInt8(index++) === 1;
        const messageNameLength = data.readDoubleBE(index);
        index += 8;
        header.messageName = data.slice(index, index += messageNameLength).toString();
        header.needACK = data.readUInt8(index++) === 1;
        header.messageID = data.readDoubleBE(index);
        return header;
    }
    /**
     * 发送数据。发送失败直接抛出异常
     *
     * @param {string} messageName 消息的名称(标题)
     * @param {(any[] | Buffer)} [data=[]] 要发送的数据。如果是传入的是数组，则数据将使用BaseSocket.serialize() 进行序列化。如果传入的是Buffer，则将直接被发送。(注意：传入的Buffer必须是BaseSocket.serialize()产生的)
     * @param {boolean} [needACK=true] 发出的这条消息是否需要确认对方是否已经收到
     * @param {boolean} [prior=false] 是否直接发送（不在缓冲队列中排队。默认false）
     * @returns {(Promise<void> & { messageID: number })} messageID
     * @memberof BaseSocket
     */
    send(messageName, data = [], needACK = true, prior = false) {
        return this._send(false, prior, messageName, needACK, data);
    }
    /**
      * 发送内部数据。发送失败直接抛出异常。内部数据默认不需要接收端确认 ，并且默认优先发送
      * 注意：要在每一个调用的地方做好异常处理
      */
    _sendInternal(messageName, data = [], needACK = false, prior = true) {
        return this._send(true, prior, messageName, needACK, data);
    }
    _send(isInternal, prior, messageName, needACK, data) {
        const msgID = this._messageID++;
        const prom = new Promise((resolve, reject) => {
            const header = this._serializeHeader(isInternal, messageName, needACK, msgID);
            let sendingData; //要发送的数据
            if (Array.isArray(data)) {
                sendingData = _Buffer.concat([header, BaseSocket.serialize(data)]);
            }
            else if (isBuffer(data)) {
                if (data._serialized)
                    sendingData = _Buffer.concat([header, data]);
                else
                    throw new Error('要被发送的Buffer并不是BaseSocket.serialize()序列化产生的');
            }
            else {
                throw new Error(`传入的数据类型存在问题，必须是数组或Buffer，而实际类型是：${Object.prototype.toString.call(data)}`);
            }
            if (this._maxPayload !== undefined && sendingData.length > this._maxPayload) {
                throw new Error('发送的数据大小超过了限制');
            }
            const control = {
                data: sendingData,
                messageID: msgID,
                sent: false,
                cancel: (err) => {
                    if (control.sent)
                        return false;
                    else {
                        this._queue.delete(msgID);
                        err ? reject(err) : resolve();
                        return true;
                    }
                },
                send: () => {
                    if (control.sent)
                        return; //避免重复发送
                    control.sent = true;
                    if (needACK) {
                        this._sendData(sendingData).catch(control.ack);
                    }
                    else {
                        this._sendData(sendingData).then(control.ack).catch(control.ack);
                    }
                },
                ack: (err) => {
                    const isFirst = this._queue.values().next().value === control;
                    this._queue.delete(msgID);
                    err ? reject(err) : resolve();
                    if (isFirst && this._queue.size > 0)
                        this._queue.values().next().value.send();
                }
            };
            this._queue.set(msgID, control); //添加到队列中
            if (prior || this._queue.size === 1) {
                control.send();
            }
        });
        prom.messageID = msgID;
        return prom;
    }
    /**
     * 解析接收到数据。子类接收到消息后需要触发这个方法
     *
     * @protected
     * @param {Buffer} data 接收到数据
     * @memberof BaseSocket
     */
    _receiveData(data) {
        try {
            const header = this._deserializeHeader(data);
            //console.log(header)
            if (header.needACK)
                this._sendInternal('ack', [header.messageID]).catch(err => this.emit('error', err));
            if (header.isInternal) {
                const body = BaseSocket.deserialize(data.slice(header.headerLength));
                switch (header.messageName) {
                    case 'ack':
                        const callback = this._queue.get(body[0]);
                        callback && callback.ack();
                        break;
                }
            }
            else {
                const body = this._needDeserialize ? BaseSocket.deserialize(data.slice(header.headerLength)) : data.slice(header.headerLength);
                setTimeout(() => {
                    this.emit('message', header.messageName, body);
                }, 0);
            }
        }
        catch (error) {
            this.emit('error', error);
        }
    }
    /**
     * 取消发送。如果某条消息还没有被取消则可以被取消。取消成功返回true，失败false
     *
     * @param {number} messageID 要取消发送消息的messageID
     * @param {Error} [err] 传递一个error，指示本次发送属于失败
     * @returns {boolean} 取消成功返回true，失败false
     * @memberof BaseSocket
     */
    cancel(messageID, err) {
        const control = this._queue.get(messageID);
        if (control) {
            return control.cancel(err);
        }
        return false;
    }
    on(event, listener) {
        super.on(event, listener);
        return this;
    }
    once(event, listener) {
        super.once(event, listener);
        return this;
    }
}
exports.BaseSocket = BaseSocket;

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImNvbW1vbi9CYXNlU29ja2V0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsNkNBQTZDO0FBRTdDLE1BQU0sT0FBTyxHQUFrQixNQUFNLEdBQUcsTUFBTSxHQUFHLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBRSxtQkFBbUI7QUFDaEcsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBT3RDOztHQUVHO0FBQ0gsZ0JBQWlDLFNBQVEsT0FBTztJQTBFNUM7Ozs7T0FJRztJQUNILFlBQVksUUFBNEIsRUFBRSxPQUF5QjtRQUMvRCxLQUFLLEVBQUUsQ0FBQztRQTlFWjs7Ozs7V0FLRztRQUNLLGVBQVUsR0FBRyxDQUFDLENBQUM7UUFNdkI7O1dBRUc7UUFDYyxXQUFNLEdBQTJCLElBQUksR0FBRyxFQUFFLENBQUM7UUFpRXhELElBQUksQ0FBQyxHQUFHLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQztRQUN2QixJQUFJLENBQUMsZ0JBQWdCLEdBQUcsT0FBTyxDQUFDLGVBQWUsS0FBSyxTQUFTLEdBQUcsSUFBSSxHQUFHLE9BQU8sQ0FBQyxlQUFlLENBQUM7UUFDL0YsSUFBSSxDQUFDLFdBQVcsR0FBRyxPQUFPLENBQUMsVUFBVSxDQUFDO1FBQ3RDLElBQUksQ0FBQyxRQUFRLEdBQUcsUUFBUSxDQUFDO1FBRXpCLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxNQUFNLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQztZQUMvQixNQUFNLElBQUksS0FBSyxDQUFDLGdCQUFnQixDQUFDLENBQUM7UUFDdEMsQ0FBQztRQUFDLElBQUksQ0FBQyxDQUFDO1lBQ0osSUFBSSxDQUFDLE1BQU0sR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDO1FBQ2pDLENBQUM7UUFFRCxJQUFJLENBQUMsRUFBRSxDQUFDLE9BQU8sRUFBRTtZQUNiLEdBQUcsQ0FBQyxDQUFDLElBQUksSUFBSSxJQUFJLENBQUMsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxDQUFDO2dCQUNuRCxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7Z0JBQzlDLEVBQUUsQ0FBQyxDQUFDLE1BQU0sS0FBSyxLQUFLLENBQUM7b0JBQ2pCLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFJLFNBQVM7WUFDakQsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ1AsQ0FBQztJQXhERDs7Ozs7OztPQU9HO0lBQ0gsSUFBSSxVQUFVO1FBQ1YsTUFBTSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsVUFBVSxDQUFDO0lBQ2xDLENBQUM7SUFFRDs7Ozs7OztPQU9HO0lBQ0gsSUFBSSxjQUFjO1FBQ2QsSUFBSSxJQUFJLEdBQUcsQ0FBQyxDQUFDO1FBRWIsR0FBRyxDQUFDLENBQUMsSUFBSSxJQUFJLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDLENBQUM7WUFDcEMsSUFBSSxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDO1FBQzdCLENBQUM7UUFFRCxNQUFNLENBQUMsSUFBSSxDQUFDO0lBQ2hCLENBQUM7SUE4QkQ7Ozs7OztPQU1HO0lBQ0gsTUFBTSxDQUFDLFNBQVMsQ0FBQyxJQUFXO1FBQ3hCLE1BQU0sV0FBVyxHQUFhLEVBQUUsQ0FBQztRQUVqQyxHQUFHLENBQUMsQ0FBQyxJQUFJLElBQUksSUFBSSxJQUFJLENBQUMsQ0FBQyxDQUFDO1lBQ3BCLE1BQU0sQ0FBQyxDQUFDLE9BQU8sSUFBSSxDQUFDLENBQUMsQ0FBQztnQkFDbEIsS0FBSyxRQUFRLEVBQUUsQ0FBQztvQkFDWixNQUFNLElBQUksR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO29CQUM5QixNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO29CQUVqQyxJQUFJLENBQUMsVUFBVSxpQkFBa0IsQ0FBQyxDQUFDLENBQUM7b0JBQ3BDLE9BQU8sQ0FBQyxhQUFhLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO29CQUUvQixXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQztvQkFDaEMsS0FBSyxDQUFDO2dCQUNWLENBQUM7Z0JBQ0QsS0FBSyxRQUFRLEVBQUUsQ0FBQztvQkFDWixNQUFNLElBQUksR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO29CQUM5QixNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO29CQUNuQyxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO29CQUV2QyxJQUFJLENBQUMsVUFBVSxpQkFBa0IsQ0FBQyxDQUFDLENBQUM7b0JBQ3BDLGFBQWEsQ0FBQyxhQUFhLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsQ0FBQztvQkFFL0MsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFLE9BQU8sQ0FBQyxDQUFDO29CQUMvQyxLQUFLLENBQUM7Z0JBQ1YsQ0FBQztnQkFDRCxLQUFLLFNBQVMsRUFBRSxDQUFDO29CQUNiLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7b0JBQzlCLE1BQU0sT0FBTyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7b0JBRWpDLElBQUksQ0FBQyxVQUFVLGtCQUFtQixDQUFDLENBQUMsQ0FBQztvQkFDckMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztvQkFFcEMsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLENBQUM7b0JBQ2hDLEtBQUssQ0FBQztnQkFDVixDQUFDO2dCQUNELEtBQUssV0FBVyxFQUFFLENBQUM7b0JBQ2YsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztvQkFDOUIsSUFBSSxDQUFDLFVBQVUsb0JBQXFCLENBQUMsQ0FBQyxDQUFDO29CQUV2QyxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO29CQUN2QixLQUFLLENBQUM7Z0JBQ1YsQ0FBQztnQkFDRCxLQUFLLFFBQVEsRUFBRSxDQUFDO29CQUNaLEVBQUUsQ0FBQyxDQUFDLElBQUksS0FBSyxJQUFJLENBQUMsQ0FBQyxDQUFDO3dCQUNoQixNQUFNLElBQUksR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO3dCQUM5QixJQUFJLENBQUMsVUFBVSxlQUFnQixDQUFDLENBQUMsQ0FBQzt3QkFFbEMsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztvQkFDM0IsQ0FBQztvQkFBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQzt3QkFDeEIsTUFBTSxJQUFJLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQzt3QkFDOUIsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDO3dCQUNyQixNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO3dCQUV2QyxJQUFJLENBQUMsVUFBVSxpQkFBa0IsQ0FBQyxDQUFDLENBQUM7d0JBQ3BDLGFBQWEsQ0FBQyxhQUFhLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsQ0FBQzt3QkFFL0MsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFLE9BQU8sQ0FBQyxDQUFDO29CQUNuRCxDQUFDO29CQUFDLElBQUksQ0FBQyxDQUFDO3dCQUNKLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7d0JBQzlCLE1BQU0sT0FBTyxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO3dCQUNuRCxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO3dCQUV2QyxJQUFJLENBQUMsVUFBVSxpQkFBa0IsQ0FBQyxDQUFDLENBQUM7d0JBQ3BDLGFBQWEsQ0FBQyxhQUFhLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsQ0FBQzt3QkFFL0MsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFLE9BQU8sQ0FBQyxDQUFDO29CQUNuRCxDQUFDO2dCQUNMLENBQUM7WUFDTCxDQUFDO1FBQ0wsQ0FBQztRQUVELE1BQU0sTUFBTSxHQUFRLE9BQU8sQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLENBQUM7UUFDaEQsTUFBTSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsQ0FBRSxnQkFBZ0I7UUFDNUMsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUNsQixDQUFDO0lBRUQ7Ozs7OztPQU1HO0lBQ0gsTUFBTSxDQUFDLFdBQVcsQ0FBQyxJQUFZO1FBQzNCLEVBQUUsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ2hCLE1BQU0sSUFBSSxLQUFLLENBQUMsaUJBQWlCLENBQUMsQ0FBQztRQUV2QyxJQUFJLFFBQVEsR0FBRyxDQUFDLENBQUM7UUFDakIsTUFBTSxNQUFNLEdBQUcsRUFBRSxDQUFDO1FBRWxCLE9BQU8sUUFBUSxHQUFHLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUM1QixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7WUFFeEMsTUFBTSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztnQkFDWCxxQkFBc0IsQ0FBQztvQkFDbkIsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7b0JBQ3pDLFFBQVEsSUFBSSxDQUFDLENBQUM7b0JBQ2QsS0FBSyxDQUFDO2dCQUNWLENBQUM7Z0JBQ0QscUJBQXNCLENBQUM7b0JBQ25CLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxZQUFZLENBQUMsUUFBUSxDQUFDLENBQUM7b0JBQzNDLFFBQVEsSUFBSSxDQUFDLENBQUM7b0JBRWQsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsUUFBUSxJQUFJLE1BQU0sQ0FBQyxDQUFDO29CQUN6RCxNQUFNLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDO29CQUNoQyxLQUFLLENBQUM7Z0JBQ1YsQ0FBQztnQkFDRCxzQkFBdUIsQ0FBQztvQkFDcEIsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDO29CQUMzQyxNQUFNLENBQUMsSUFBSSxDQUFDLE9BQU8sS0FBSyxDQUFDLENBQUMsQ0FBQztvQkFDM0IsS0FBSyxDQUFDO2dCQUNWLENBQUM7Z0JBQ0Qsd0JBQXlCLENBQUM7b0JBQ3RCLE1BQU0sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7b0JBQ3ZCLEtBQUssQ0FBQztnQkFDVixDQUFDO2dCQUNELG1CQUFvQixDQUFDO29CQUNqQixNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO29CQUNsQixLQUFLLENBQUM7Z0JBQ1YsQ0FBQztnQkFDRCxxQkFBc0IsQ0FBQztvQkFDbkIsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLFlBQVksQ0FBQyxRQUFRLENBQUMsQ0FBQztvQkFDM0MsUUFBUSxJQUFJLENBQUMsQ0FBQztvQkFFZCxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLFFBQVEsSUFBSSxNQUFNLENBQUMsQ0FBQyxDQUFDO29CQUN0RCxLQUFLLENBQUM7Z0JBQ1YsQ0FBQztnQkFDRCxxQkFBc0IsQ0FBQztvQkFDbkIsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLFlBQVksQ0FBQyxRQUFRLENBQUMsQ0FBQztvQkFDM0MsUUFBUSxJQUFJLENBQUMsQ0FBQztvQkFFZCxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxRQUFRLElBQUksTUFBTSxDQUFDLENBQUM7b0JBQ3pELE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQyxDQUFDO29CQUM1QyxLQUFLLENBQUM7Z0JBQ1YsQ0FBQztnQkFDRCxTQUFTLENBQUM7b0JBQ04sTUFBTSxJQUFJLEtBQUssQ0FBQywrQkFBK0IsR0FBRyxJQUFJLENBQUMsQ0FBQztnQkFDNUQsQ0FBQztZQUNMLENBQUM7UUFDTCxDQUFDO1FBRUQsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUNsQixDQUFDO0lBRUQ7Ozs7Ozs7Ozs7O09BV0c7SUFDSyxnQkFBZ0IsQ0FBQyxVQUFtQixFQUFFLFdBQW1CLEVBQUUsT0FBZ0IsRUFBRSxTQUFpQjtRQUNsRyxJQUFJLGFBQWEsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ3JDLElBQUksV0FBVyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbkMsSUFBSSxrQkFBa0IsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzFDLElBQUksWUFBWSxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUM7UUFDN0MsSUFBSSxRQUFRLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNoQyxJQUFJLFVBQVUsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBRWxDLFdBQVcsQ0FBQyxVQUFVLENBQUMsVUFBVSxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDOUMsa0JBQWtCLENBQUMsYUFBYSxDQUFDLFlBQVksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDekQsUUFBUSxDQUFDLFVBQVUsQ0FBQyxPQUFPLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUN4QyxVQUFVLENBQUMsYUFBYSxDQUFDLFNBQVMsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUV2QyxJQUFJLE1BQU0sR0FBRyxhQUFhLENBQUMsTUFBTSxHQUFHLFdBQVcsQ0FBQyxNQUFNLEdBQUcsWUFBWSxDQUFDLE1BQU0sR0FBRyxrQkFBa0IsQ0FBQyxNQUFNLEdBQUcsUUFBUSxDQUFDLE1BQU0sR0FBRyxVQUFVLENBQUMsTUFBTSxDQUFDO1FBQy9JLGFBQWEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBRXZDLE1BQU0sQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsYUFBYSxFQUFFLFdBQVcsRUFBRSxrQkFBa0IsRUFBRSxZQUFZLEVBQUUsUUFBUSxFQUFFLFVBQVUsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ3ZILENBQUM7SUFFRDs7O09BR0c7SUFDSyxrQkFBa0IsQ0FBQyxJQUFZO1FBQ25DLEVBQUUsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ2hCLE1BQU0sSUFBSSxLQUFLLENBQUMsaUJBQWlCLENBQUMsQ0FBQztRQUV2QyxNQUFNLE1BQU0sR0FBRztZQUNYLFVBQVUsRUFBRSxJQUFJO1lBQ2hCLFdBQVcsRUFBRSxFQUFFO1lBQ2YsT0FBTyxFQUFFLEtBQUs7WUFDZCxTQUFTLEVBQUUsQ0FBQyxDQUFDO1lBQ2IsWUFBWSxFQUFFLENBQUM7U0FDbEIsQ0FBQztRQUVGLE1BQU0sQ0FBQyxZQUFZLEdBQUcsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUMzQyxJQUFJLEtBQUssR0FBRyxDQUFDLENBQUM7UUFFZCxNQUFNLENBQUMsVUFBVSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFbEQsTUFBTSxpQkFBaUIsR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ25ELEtBQUssSUFBSSxDQUFDLENBQUM7UUFFWCxNQUFNLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLEtBQUssSUFBSSxpQkFBaUIsQ0FBQyxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBRTlFLE1BQU0sQ0FBQyxPQUFPLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUUvQyxNQUFNLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFNUMsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUNsQixDQUFDO0lBRUQ7Ozs7Ozs7OztPQVNHO0lBQ0gsSUFBSSxDQUFDLFdBQW1CLEVBQUUsT0FBdUIsRUFBRSxFQUFFLFVBQW1CLElBQUksRUFBRSxRQUFpQixLQUFLO1FBQ2hHLE1BQU0sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxLQUFLLEVBQUUsV0FBVyxFQUFFLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNoRSxDQUFDO0lBRUQ7OztRQUdJO0lBQ00sYUFBYSxDQUFDLFdBQW1CLEVBQUUsT0FBdUIsRUFBRSxFQUFFLFVBQW1CLEtBQUssRUFBRSxRQUFpQixJQUFJO1FBQ25ILE1BQU0sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsV0FBVyxFQUFFLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQztJQUMvRCxDQUFDO0lBRU8sS0FBSyxDQUFDLFVBQW1CLEVBQUUsS0FBYyxFQUFFLFdBQW1CLEVBQUUsT0FBZ0IsRUFBRSxJQUFvQjtRQUMxRyxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7UUFDaEMsTUFBTSxJQUFJLEdBQVEsSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTTtZQUMxQyxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsVUFBVSxFQUFFLFdBQVcsRUFBRSxPQUFPLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFFOUUsSUFBSSxXQUFtQixDQUFDLENBQUksUUFBUTtZQUNwQyxFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDdEIsV0FBVyxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLEVBQUUsVUFBVSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDdkUsQ0FBQztZQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUN4QixFQUFFLENBQUMsQ0FBTyxJQUFLLENBQUMsV0FBVyxDQUFDO29CQUN4QixXQUFXLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDO2dCQUNqRCxJQUFJO29CQUNBLE1BQU0sSUFBSSxLQUFLLENBQUMsNENBQTRDLENBQUMsQ0FBQztZQUN0RSxDQUFDO1lBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ0osTUFBTSxJQUFJLEtBQUssQ0FBQyxtQ0FBbUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUMvRixDQUFDO1lBRUQsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLFdBQVcsS0FBSyxTQUFTLElBQUksV0FBVyxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQztnQkFDMUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxjQUFjLENBQUMsQ0FBQztZQUNwQyxDQUFDO1lBRUQsTUFBTSxPQUFPLEdBQWM7Z0JBQ3ZCLElBQUksRUFBRSxXQUFXO2dCQUNqQixTQUFTLEVBQUUsS0FBSztnQkFDaEIsSUFBSSxFQUFFLEtBQUs7Z0JBQ1gsTUFBTSxFQUFFLENBQUMsR0FBRztvQkFDUixFQUFFLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDO3dCQUNiLE1BQU0sQ0FBQyxLQUFLLENBQUM7b0JBQ2pCLElBQUksQ0FBQyxDQUFDO3dCQUNGLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO3dCQUMxQixHQUFHLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHLE9BQU8sRUFBRSxDQUFDO3dCQUM5QixNQUFNLENBQUMsSUFBSSxDQUFDO29CQUNoQixDQUFDO2dCQUNMLENBQUM7Z0JBQ0QsSUFBSSxFQUFFO29CQUNGLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUM7d0JBQUMsTUFBTSxDQUFDLENBQUcsUUFBUTtvQkFDcEMsT0FBTyxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7b0JBRXBCLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7d0JBQ1YsSUFBSSxDQUFDLFNBQVMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDO29CQUNuRCxDQUFDO29CQUFDLElBQUksQ0FBQyxDQUFDO3dCQUNKLElBQUksQ0FBQyxTQUFTLENBQUMsV0FBVyxDQUFDLENBQUMsSUFBSSxDQUFNLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDO29CQUMxRSxDQUFDO2dCQUNMLENBQUM7Z0JBQ0QsR0FBRyxFQUFFLENBQUMsR0FBRztvQkFDTCxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU0sRUFBRSxDQUFDLElBQUksRUFBRSxDQUFDLEtBQUssS0FBSyxPQUFPLENBQUM7b0JBQzlELElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO29CQUMxQixHQUFHLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHLE9BQU8sRUFBRSxDQUFDO29CQUU5QixFQUFFLENBQUMsQ0FBQyxPQUFPLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDO3dCQUNoQyxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU0sRUFBRSxDQUFDLElBQUksRUFBRSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztnQkFDakQsQ0FBQzthQUNKLENBQUM7WUFFRixJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBSSxRQUFRO1lBRTVDLEVBQUUsQ0FBQyxDQUFDLEtBQUssSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO2dCQUNsQyxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDbkIsQ0FBQztRQUNMLENBQUMsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxDQUFDLFNBQVMsR0FBRyxLQUFLLENBQUM7UUFDdkIsTUFBTSxDQUFDLElBQUksQ0FBQztJQUNoQixDQUFDO0lBYUQ7Ozs7OztPQU1HO0lBQ08sWUFBWSxDQUFDLElBQVk7UUFDL0IsSUFBSSxDQUFDO1lBQ0QsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLGtCQUFrQixDQUFDLElBQUksQ0FBQyxDQUFDO1lBQzdDLHFCQUFxQjtZQUNyQixFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDO2dCQUNmLElBQUksQ0FBQyxhQUFhLENBQUMsS0FBSyxFQUFFLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBRXhGLEVBQUUsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDO2dCQUNwQixNQUFNLElBQUksR0FBRyxVQUFVLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUM7Z0JBRXJFLE1BQU0sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDO29CQUN6QixLQUFLLEtBQUs7d0JBQ04sTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7d0JBQzFDLFFBQVEsSUFBSSxRQUFRLENBQUMsR0FBRyxFQUFFLENBQUM7d0JBQzNCLEtBQUssQ0FBQztnQkFDZCxDQUFDO1lBQ0wsQ0FBQztZQUFDLElBQUksQ0FBQyxDQUFDO2dCQUNKLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxVQUFVLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUFDLENBQUM7Z0JBQy9ILFVBQVUsQ0FBQztvQkFDUCxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxNQUFNLENBQUMsV0FBVyxFQUFFLElBQUksQ0FBQyxDQUFDO2dCQUNuRCxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7WUFDVixDQUFDO1FBQ0wsQ0FBQztRQUFDLEtBQUssQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7WUFDYixJQUFJLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxLQUFLLENBQUMsQ0FBQztRQUM5QixDQUFDO0lBQ0wsQ0FBQztJQUVEOzs7Ozs7O09BT0c7SUFDSCxNQUFNLENBQUMsU0FBaUIsRUFBRSxHQUFXO1FBQ2pDLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBRTNDLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7WUFDVixNQUFNLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUMvQixDQUFDO1FBRUQsTUFBTSxDQUFDLEtBQUssQ0FBQztJQUNqQixDQUFDO0lBd0JELEVBQUUsQ0FBQyxLQUFhLEVBQUUsUUFBa0I7UUFDaEMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFDMUIsTUFBTSxDQUFDLElBQUksQ0FBQztJQUNoQixDQUFDO0lBWUQsSUFBSSxDQUFDLEtBQWEsRUFBRSxRQUFrQjtRQUNsQyxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxRQUFRLENBQUMsQ0FBQztRQUM1QixNQUFNLENBQUMsSUFBSSxDQUFDO0lBQ2hCLENBQUM7Q0FDSjtBQTVmRCxnQ0E0ZkMiLCJmaWxlIjoiY29tbW9uL0Jhc2VTb2NrZXQuanMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBFbWl0dGVyIGZyb20gJ2NvbXBvbmVudC1lbWl0dGVyJztcclxuaW1wb3J0ICogYXMgV1MgZnJvbSAnd3MnO1xyXG5jb25zdCBfQnVmZmVyOiB0eXBlb2YgQnVmZmVyID0gQnVmZmVyID8gQnVmZmVyIDogcmVxdWlyZSgnYnVmZmVyLycpLkJ1ZmZlcjsgIC8vIOehruS/nea1j+iniOWZqOS4i+S5n+iDveS9v+eUqEJ1ZmZlclxyXG5jb25zdCBpc0J1ZmZlciA9IHJlcXVpcmUoJ2lzLWJ1ZmZlcicpO1xyXG5cclxuaW1wb3J0IHsgUmVhZHlTdGF0ZSB9IGZyb20gXCIuL1JlYWR5U3RhdGVcIjtcclxuaW1wb3J0IHsgQmFzZVNvY2tldENvbmZpZyB9IGZyb20gJy4vQmFzZVNvY2tldENvbmZpZyc7XHJcbmltcG9ydCB7IERhdGFUeXBlIH0gZnJvbSAnLi4vY29tbW9uL0RhdGFUeXBlJztcclxuaW1wb3J0IHsgUXVldWVEYXRhIH0gZnJvbSAnLi9RdWV1ZURhdGEnO1xyXG5cclxuLyoqXHJcbiAqIFNvY2tldCDmjqXlj6PnmoTmir3osaHnsbvvvIzlrprkuYnkuoZzb2NrZXTpnIDopoHlrp7njrDnmoTln7rnoYDlip/og71cclxuICovXHJcbmV4cG9ydCBhYnN0cmFjdCBjbGFzcyBCYXNlU29ja2V0IGV4dGVuZHMgRW1pdHRlciB7XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBfbWVzc2FnZUlEIOeahElE5Y+377yMaWTku44w5byA5aeL44CC5q+P5Y+R5LiA5p2h5raI5oGv77yM6K+laWTliqAxXHJcbiAgICAgKiBcclxuICAgICAqIEBwcml2YXRlXHJcbiAgICAgKiBAbWVtYmVyb2YgQmFzZVNvY2tldFxyXG4gICAgICovXHJcbiAgICBwcml2YXRlIF9tZXNzYWdlSUQgPSAwO1xyXG5cclxuICAgIHByaXZhdGUgcmVhZG9ubHkgX25lZWREZXNlcmlhbGl6ZTogYm9vbGVhbjtcclxuXHJcbiAgICBwcml2YXRlIHJlYWRvbmx5IF9tYXhQYXlsb2FkOiBudW1iZXIgfCB1bmRlZmluZWQ7XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiDnrYnlvoXlj5HpgIHmtojmga/nmoTpmJ/liJfjgIJrZXnvvJptZXNzYWdlSUTjgIJcclxuICAgICAqL1xyXG4gICAgcHJpdmF0ZSByZWFkb25seSBfcXVldWU6IE1hcDxudW1iZXIsIFF1ZXVlRGF0YT4gPSBuZXcgTWFwKCk7XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiDkv53lrZjooqvljIXoo4XnmoRzb2NrZXTlr7nosaFcclxuICAgICAqIFxyXG4gICAgICogQHR5cGUgeyhXZWJTb2NrZXR8V1MpfVxyXG4gICAgICogQG1lbWJlcm9mIEJhc2VTb2NrZXRcclxuICAgICAqL1xyXG4gICAgcmVhZG9ubHkgc29ja2V0OiBXZWJTb2NrZXQgfCBXUztcclxuXHJcbiAgICAvKipcclxuICAgICAqIFdlYlNvY2tldCBzZXJ2ZXIg55qEVVJM5Zyw5Z2AICAgXHJcbiAgICAgKiDms6jmhI/vvJrlpoLmnpzmmK9TZXJ2ZXLnlJ/miJDnmoRTb2NrZXTvvIzliJl1cmzkuLrnqbrlrZfnrKbkuLJcclxuICAgICAqIFxyXG4gICAgICogQHR5cGUge3N0cmluZ31cclxuICAgICAqIEBtZW1iZXJvZiBCYXNlU29ja2V0XHJcbiAgICAgKi9cclxuICAgIHJlYWRvbmx5IHVybDogc3RyaW5nO1xyXG5cclxuICAgIC8qKlxyXG4gICAgICog5b2T5YmN5o6l5Y+j6L+Q6KGM5omA5aSE55qE5bmz5Y+wXHJcbiAgICAgKiBcclxuICAgICAqIEB0eXBlIHsoXCJicm93c2VyXCIgfCBcIm5vZGVcIil9XHJcbiAgICAgKiBAbWVtYmVyb2YgQmFzZVNvY2tldFxyXG4gICAgICovXHJcbiAgICByZWFkb25seSBwbGF0Zm9ybTogXCJicm93c2VyXCIgfCBcIm5vZGVcIjtcclxuXHJcbiAgICAvKipcclxuICAgICAqIOi/nuaOpeeahOW9k+WJjeeKtuaAgVxyXG4gICAgICogXHJcbiAgICAgKiBAcmVhZG9ubHlcclxuICAgICAqIEBhYnN0cmFjdFxyXG4gICAgICogQHR5cGUge1JlYWR5U3RhdGV9XHJcbiAgICAgKiBAbWVtYmVyb2YgQmFzZVNvY2tldFxyXG4gICAgICovXHJcbiAgICBnZXQgcmVhZHlTdGF0ZSgpOiBSZWFkeVN0YXRlIHtcclxuICAgICAgICByZXR1cm4gdGhpcy5zb2NrZXQucmVhZHlTdGF0ZTtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIOWcqOe8k+WGsumYn+WIl+S4reetieW+heWPkemAgeeahOaVsOaNruWtl+iKguaVsFxyXG4gICAgICogXHJcbiAgICAgKiBAcmVhZG9ubHlcclxuICAgICAqIEBhYnN0cmFjdFxyXG4gICAgICogQHR5cGUge251bWJlcn1cclxuICAgICAqIEBtZW1iZXJvZiBCYXNlU29ja2V0XHJcbiAgICAgKi9cclxuICAgIGdldCBidWZmZXJlZEFtb3VudCgpOiBudW1iZXIge1xyXG4gICAgICAgIGxldCBzaXplID0gMDtcclxuXHJcbiAgICAgICAgZm9yIChsZXQgaXRlbSBvZiB0aGlzLl9xdWV1ZS52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBzaXplICs9IGl0ZW0uZGF0YS5sZW5ndGg7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICByZXR1cm4gc2l6ZTtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIEBwYXJhbSB7KFwiYnJvd3NlclwiIHwgXCJub2RlXCIpfSBwbGF0Zm9ybSDmjIfnpLror6XmjqXlj6PmiYDlpITnmoTlubPlj7BcclxuICAgICAqIEBwYXJhbSB7QmFzZVNvY2tldENvbmZpZ30gY29uZmlncyDphY3nva5cclxuICAgICAqIEBtZW1iZXJvZiBCYXNlU29ja2V0XHJcbiAgICAgKi9cclxuICAgIGNvbnN0cnVjdG9yKHBsYXRmb3JtOiBcImJyb3dzZXJcIiB8IFwibm9kZVwiLCBjb25maWdzOiBCYXNlU29ja2V0Q29uZmlnKSB7XHJcbiAgICAgICAgc3VwZXIoKTtcclxuXHJcbiAgICAgICAgdGhpcy51cmwgPSBjb25maWdzLnVybDtcclxuICAgICAgICB0aGlzLl9uZWVkRGVzZXJpYWxpemUgPSBjb25maWdzLm5lZWREZXNlcmlhbGl6ZSA9PT0gdW5kZWZpbmVkID8gdHJ1ZSA6IGNvbmZpZ3MubmVlZERlc2VyaWFsaXplO1xyXG4gICAgICAgIHRoaXMuX21heFBheWxvYWQgPSBjb25maWdzLm1heFBheWxvYWQ7XHJcbiAgICAgICAgdGhpcy5wbGF0Zm9ybSA9IHBsYXRmb3JtO1xyXG5cclxuICAgICAgICBpZiAoY29uZmlncy5zb2NrZXQgPT09IHVuZGVmaW5lZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+S8oOWFpeeahHNvY2tldOS4jeWPr+S7peS4uuepuicpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHRoaXMuc29ja2V0ID0gY29uZmlncy5zb2NrZXQ7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICB0aGlzLm9uKCdjbG9zZScsICgpID0+IHsgICAgLy/lpoLmnpzmlq3lvIDvvIznu4jmraLmiYDmnInov5jmnKrlj5HpgIHnmoTmtojmga9cclxuICAgICAgICAgICAgZm9yIChsZXQgaXRlbSBvZiBbLi4udGhpcy5fcXVldWUudmFsdWVzKCldLnJldmVyc2UoKSkgeyAvL+S7juWQjuWQkeWJjeWPlua2iFxyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gaXRlbS5jYW5jZWwobmV3IEVycm9yKCfov57mjqXkuK3mlq0nKSk7XHJcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0ID09PSBmYWxzZSlcclxuICAgICAgICAgICAgICAgICAgICBpdGVtLmFjayhuZXcgRXJyb3IoJ+i/nuaOpeS4reaWrScpKTsgICAgLy/lj5bmtojmraPlnKjlj5HpgIHnmoRcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICog5a+56KaB5Y+R6YCB55qE5pWw5o2u6L+b6KGM5bqP5YiX5YyW44CC5rOo5oSP5Y+q5pyJ5L2N5LqO5pWw57uE5qC55LiL55qEYm9vbGVhbuOAgXN0cmluZ+OAgW51bWJlcuOAgXZvaWTjgIFCdWZmZXLmiY3kvJrov5vooYzkuozov5vliLbluo/liJfljJbvvIzlr7nosaHkvJrooqtKU09OLnN0cmluZ2lmeSAgICBcclxuICAgICAqIOaVsOaNruagvOW8j++8miDlhYPntKDnsbvlnosgLT4gW+WFg+e0oOmVv+W6pl0gLT4g5YWD57Sg5YaF5a65XHJcbiAgICAgKiBcclxuICAgICAqIEBzdGF0aWNcclxuICAgICAqIEBtZW1iZXJvZiBCYXNlU29ja2V0XHJcbiAgICAgKi9cclxuICAgIHN0YXRpYyBzZXJpYWxpemUoZGF0YTogYW55W10pOiBCdWZmZXIgJiB7IF9zZXJpYWxpemVkOiBib29sZWFuIH0ge1xyXG4gICAgICAgIGNvbnN0IGJ1ZmZlckl0ZW1zOiBCdWZmZXJbXSA9IFtdO1xyXG5cclxuICAgICAgICBmb3IgKGxldCBpdGVtIG9mIGRhdGEpIHtcclxuICAgICAgICAgICAgc3dpdGNoICh0eXBlb2YgaXRlbSkge1xyXG4gICAgICAgICAgICAgICAgY2FzZSAnbnVtYmVyJzoge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBfQnVmZmVyLmFsbG9jKDEpO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBfQnVmZmVyLmFsbG9jKDgpO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICB0eXBlLndyaXRlVUludDgoRGF0YVR5cGUubnVtYmVyLCAwKTtcclxuICAgICAgICAgICAgICAgICAgICBjb250ZW50LndyaXRlRG91YmxlQkUoaXRlbSwgMCk7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgIGJ1ZmZlckl0ZW1zLnB1c2godHlwZSwgY29udGVudCk7XHJcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjYXNlICdzdHJpbmcnOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdHlwZSA9IF9CdWZmZXIuYWxsb2MoMSk7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY29udGVudCA9IF9CdWZmZXIuZnJvbShpdGVtKTtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBjb250ZW50TGVuZ3RoID0gX0J1ZmZlci5hbGxvYyg4KTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgdHlwZS53cml0ZVVJbnQ4KERhdGFUeXBlLnN0cmluZywgMCk7XHJcbiAgICAgICAgICAgICAgICAgICAgY29udGVudExlbmd0aC53cml0ZURvdWJsZUJFKGNvbnRlbnQubGVuZ3RoLCAwKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgYnVmZmVySXRlbXMucHVzaCh0eXBlLCBjb250ZW50TGVuZ3RoLCBjb250ZW50KTtcclxuICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNhc2UgJ2Jvb2xlYW4nOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdHlwZSA9IF9CdWZmZXIuYWxsb2MoMSk7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY29udGVudCA9IF9CdWZmZXIuYWxsb2MoMSk7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgIHR5cGUud3JpdGVVSW50OChEYXRhVHlwZS5ib29sZWFuLCAwKTtcclxuICAgICAgICAgICAgICAgICAgICBjb250ZW50LndyaXRlVUludDgoaXRlbSA/IDEgOiAwLCAwKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgYnVmZmVySXRlbXMucHVzaCh0eXBlLCBjb250ZW50KTtcclxuICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNhc2UgJ3VuZGVmaW5lZCc6IHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCB0eXBlID0gX0J1ZmZlci5hbGxvYygxKTtcclxuICAgICAgICAgICAgICAgICAgICB0eXBlLndyaXRlVUludDgoRGF0YVR5cGUudW5kZWZpbmVkLCAwKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgYnVmZmVySXRlbXMucHVzaCh0eXBlKTtcclxuICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNhc2UgJ29iamVjdCc6IHtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoaXRlbSA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB0eXBlID0gX0J1ZmZlci5hbGxvYygxKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZS53cml0ZVVJbnQ4KERhdGFUeXBlLm51bGwsIDApO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgYnVmZmVySXRlbXMucHVzaCh0eXBlKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGlzQnVmZmVyKGl0ZW0pKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBfQnVmZmVyLmFsbG9jKDEpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBjb250ZW50ID0gaXRlbTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgY29udGVudExlbmd0aCA9IF9CdWZmZXIuYWxsb2MoOCk7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlLndyaXRlVUludDgoRGF0YVR5cGUuQnVmZmVyLCAwKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGVudExlbmd0aC53cml0ZURvdWJsZUJFKGNvbnRlbnQubGVuZ3RoLCAwKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1ZmZlckl0ZW1zLnB1c2godHlwZSwgY29udGVudExlbmd0aCwgY29udGVudCk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdHlwZSA9IF9CdWZmZXIuYWxsb2MoMSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBfQnVmZmVyLmZyb20oSlNPTi5zdHJpbmdpZnkoaXRlbSkpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBjb250ZW50TGVuZ3RoID0gX0J1ZmZlci5hbGxvYyg4KTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGUud3JpdGVVSW50OChEYXRhVHlwZS5PYmplY3QsIDApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZW50TGVuZ3RoLndyaXRlRG91YmxlQkUoY29udGVudC5sZW5ndGgsIDApO1xyXG5cclxuICAgICAgICAgICAgICAgICAgICAgICAgYnVmZmVySXRlbXMucHVzaCh0eXBlLCBjb250ZW50TGVuZ3RoLCBjb250ZW50KTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHJlc3VsdDogYW55ID0gX0J1ZmZlci5jb25jYXQoYnVmZmVySXRlbXMpO1xyXG4gICAgICAgIHJlc3VsdC5fc2VyaWFsaXplZCA9IHRydWU7ICAvL+agh+iusOi/meS7veaVsOaNruaYr+iiq+W6j+WIl+WMlui/h+S6hueahFxyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiDlr7nmjqXmlLbliLDnmoTmtojmga/ov5vooYzlj43luo/liJfljJZcclxuICAgICAqIFxyXG4gICAgICogQHN0YXRpY1xyXG4gICAgICogQHBhcmFtIHtCdWZmZXJ9IGRhdGEgXHJcbiAgICAgKiBAbWVtYmVyb2YgQmFzZVNvY2tldFxyXG4gICAgICovXHJcbiAgICBzdGF0aWMgZGVzZXJpYWxpemUoZGF0YTogQnVmZmVyKTogYW55W10ge1xyXG4gICAgICAgIGlmICghaXNCdWZmZXIoZGF0YSkpXHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5Lyg5YWl55qE5pWw5o2u57G75Z6L5LiN5pivQnVmZmVyJyk7XHJcblxyXG4gICAgICAgIGxldCBwcmV2aW91cyA9IDA7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gW107XHJcblxyXG4gICAgICAgIHdoaWxlIChwcmV2aW91cyA8IGRhdGEubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHR5cGUgPSBkYXRhLnJlYWRVSW50OChwcmV2aW91cysrKTtcclxuXHJcbiAgICAgICAgICAgIHN3aXRjaCAodHlwZSkge1xyXG4gICAgICAgICAgICAgICAgY2FzZSBEYXRhVHlwZS5udW1iZXI6IHtcclxuICAgICAgICAgICAgICAgICAgICByZXN1bHQucHVzaChkYXRhLnJlYWREb3VibGVCRShwcmV2aW91cykpO1xyXG4gICAgICAgICAgICAgICAgICAgIHByZXZpb3VzICs9IDg7XHJcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjYXNlIERhdGFUeXBlLnN0cmluZzoge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGxlbmd0aCA9IGRhdGEucmVhZERvdWJsZUJFKHByZXZpb3VzKTtcclxuICAgICAgICAgICAgICAgICAgICBwcmV2aW91cyArPSA4O1xyXG5cclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBjb250ZW50ID0gZGF0YS5zbGljZShwcmV2aW91cywgcHJldmlvdXMgKz0gbGVuZ3RoKTtcclxuICAgICAgICAgICAgICAgICAgICByZXN1bHQucHVzaChjb250ZW50LnRvU3RyaW5nKCkpO1xyXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY2FzZSBEYXRhVHlwZS5ib29sZWFuOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY29udGVudCA9IGRhdGEucmVhZFVJbnQ4KHByZXZpb3VzKyspO1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdC5wdXNoKGNvbnRlbnQgPT09IDEpO1xyXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY2FzZSBEYXRhVHlwZS51bmRlZmluZWQ6IHtcclxuICAgICAgICAgICAgICAgICAgICByZXN1bHQucHVzaCh1bmRlZmluZWQpO1xyXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY2FzZSBEYXRhVHlwZS5udWxsOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0LnB1c2gobnVsbCk7XHJcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjYXNlIERhdGFUeXBlLkJ1ZmZlcjoge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGxlbmd0aCA9IGRhdGEucmVhZERvdWJsZUJFKHByZXZpb3VzKTtcclxuICAgICAgICAgICAgICAgICAgICBwcmV2aW91cyArPSA4O1xyXG5cclxuICAgICAgICAgICAgICAgICAgICByZXN1bHQucHVzaChkYXRhLnNsaWNlKHByZXZpb3VzLCBwcmV2aW91cyArPSBsZW5ndGgpKTtcclxuICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNhc2UgRGF0YVR5cGUuT2JqZWN0OiB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbGVuZ3RoID0gZGF0YS5yZWFkRG91YmxlQkUocHJldmlvdXMpO1xyXG4gICAgICAgICAgICAgICAgICAgIHByZXZpb3VzICs9IDg7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBkYXRhLnNsaWNlKHByZXZpb3VzLCBwcmV2aW91cyArPSBsZW5ndGgpO1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdC5wdXNoKEpTT04ucGFyc2UoY29udGVudC50b1N0cmluZygpKSk7XHJcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBkZWZhdWx0OiB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdkYXRhIHR5cGUgZG9uYHQgZXhpc3QuIHR5cGU6ICcgKyB0eXBlKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIOW6j+WIl+WMlua2iOaBr+WktOmDqOOAgiAgICBcclxuICAgICAqIOaVsOaNruagvOW8j++8muWktOmDqOmVv+W6piAtPiDmmK/lkKbmmK/lhoXpg6jmtojmga8gLT4g5raI5oGv5ZCN56ew6ZW/5bqmIC0+IOa2iOaBr+WQjeensCAtPiDor6Xmtojmga/mmK/lkKbpnIDopoHnoa7orqTmlLbliLAgLT4g5raI5oGvaWRcclxuICAgICAqIFxyXG4gICAgICogQHByaXZhdGVcclxuICAgICAqIEBwYXJhbSB7Ym9vbGVhbn0gaXNJbnRlcm5hbCDmmK/lkKbmmK/lhoXpg6jmtojmga9cclxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtZXNzYWdlTmFtZSDmtojmga/nmoTlkI3np7BcclxuICAgICAqIEBwYXJhbSB7Ym9vbGVhbn0gbmVlZEFDSyBcclxuICAgICAqIEBwYXJhbSB7bnVtYmVyfSBtZXNzYWdlSURcclxuICAgICAqIEByZXR1cm5zIHtCdWZmZXJ9IFxyXG4gICAgICogQG1lbWJlcm9mIEJhc2VTb2NrZXRcclxuICAgICAqL1xyXG4gICAgcHJpdmF0ZSBfc2VyaWFsaXplSGVhZGVyKGlzSW50ZXJuYWw6IGJvb2xlYW4sIG1lc3NhZ2VOYW1lOiBzdHJpbmcsIG5lZWRBQ0s6IGJvb2xlYW4sIG1lc3NhZ2VJRDogbnVtYmVyKTogQnVmZmVyIHtcclxuICAgICAgICBsZXQgX2hlYWRlckxlbmd0aCA9IF9CdWZmZXIuYWxsb2MoOCk7XHJcbiAgICAgICAgbGV0IF9pc0ludGVybmFsID0gX0J1ZmZlci5hbGxvYygxKTtcclxuICAgICAgICBsZXQgX21lc3NhZ2VOYW1lTGVuZ3RoID0gX0J1ZmZlci5hbGxvYyg4KTtcclxuICAgICAgICBsZXQgX21lc3NhZ2VOYW1lID0gX0J1ZmZlci5mcm9tKG1lc3NhZ2VOYW1lKTtcclxuICAgICAgICBsZXQgX25lZWRBQ0sgPSBfQnVmZmVyLmFsbG9jKDEpO1xyXG4gICAgICAgIGxldCBfbWVzc2FnZUlEID0gX0J1ZmZlci5hbGxvYyg4KTtcclxuXHJcbiAgICAgICAgX2lzSW50ZXJuYWwud3JpdGVVSW50OChpc0ludGVybmFsID8gMSA6IDAsIDApO1xyXG4gICAgICAgIF9tZXNzYWdlTmFtZUxlbmd0aC53cml0ZURvdWJsZUJFKF9tZXNzYWdlTmFtZS5sZW5ndGgsIDApO1xyXG4gICAgICAgIF9uZWVkQUNLLndyaXRlVUludDgobmVlZEFDSyA/IDEgOiAwLCAwKTtcclxuICAgICAgICBfbWVzc2FnZUlELndyaXRlRG91YmxlQkUobWVzc2FnZUlELCAwKTtcclxuXHJcbiAgICAgICAgbGV0IGxlbmd0aCA9IF9oZWFkZXJMZW5ndGgubGVuZ3RoICsgX2lzSW50ZXJuYWwubGVuZ3RoICsgX21lc3NhZ2VOYW1lLmxlbmd0aCArIF9tZXNzYWdlTmFtZUxlbmd0aC5sZW5ndGggKyBfbmVlZEFDSy5sZW5ndGggKyBfbWVzc2FnZUlELmxlbmd0aDtcclxuICAgICAgICBfaGVhZGVyTGVuZ3RoLndyaXRlRG91YmxlQkUobGVuZ3RoLCAwKTtcclxuXHJcbiAgICAgICAgcmV0dXJuIEJ1ZmZlci5jb25jYXQoW19oZWFkZXJMZW5ndGgsIF9pc0ludGVybmFsLCBfbWVzc2FnZU5hbWVMZW5ndGgsIF9tZXNzYWdlTmFtZSwgX25lZWRBQ0ssIF9tZXNzYWdlSURdLCBsZW5ndGgpO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICog5Y+N5bqP5YiX5YyW5aS06YOoXHJcbiAgICAgKiBAcGFyYW0gZGF0YSDlpLTpg6jkuozov5vliLbmlbDmja5cclxuICAgICAqL1xyXG4gICAgcHJpdmF0ZSBfZGVzZXJpYWxpemVIZWFkZXIoZGF0YTogQnVmZmVyKSB7XHJcbiAgICAgICAgaWYgKCFpc0J1ZmZlcihkYXRhKSlcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfkvKDlhaXnmoTmlbDmja7nsbvlnovkuI3mmK9CdWZmZXInKTtcclxuXHJcbiAgICAgICAgY29uc3QgaGVhZGVyID0ge1xyXG4gICAgICAgICAgICBpc0ludGVybmFsOiB0cnVlLFxyXG4gICAgICAgICAgICBtZXNzYWdlTmFtZTogJycsXHJcbiAgICAgICAgICAgIG5lZWRBQ0s6IGZhbHNlLFxyXG4gICAgICAgICAgICBtZXNzYWdlSUQ6IC0xLFxyXG4gICAgICAgICAgICBoZWFkZXJMZW5ndGg6IDBcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICBoZWFkZXIuaGVhZGVyTGVuZ3RoID0gZGF0YS5yZWFkRG91YmxlQkUoMCk7XHJcbiAgICAgICAgbGV0IGluZGV4ID0gODtcclxuXHJcbiAgICAgICAgaGVhZGVyLmlzSW50ZXJuYWwgPSBkYXRhLnJlYWRVSW50OChpbmRleCsrKSA9PT0gMTtcclxuXHJcbiAgICAgICAgY29uc3QgbWVzc2FnZU5hbWVMZW5ndGggPSBkYXRhLnJlYWREb3VibGVCRShpbmRleCk7XHJcbiAgICAgICAgaW5kZXggKz0gODtcclxuXHJcbiAgICAgICAgaGVhZGVyLm1lc3NhZ2VOYW1lID0gZGF0YS5zbGljZShpbmRleCwgaW5kZXggKz0gbWVzc2FnZU5hbWVMZW5ndGgpLnRvU3RyaW5nKCk7XHJcblxyXG4gICAgICAgIGhlYWRlci5uZWVkQUNLID0gZGF0YS5yZWFkVUludDgoaW5kZXgrKykgPT09IDE7XHJcblxyXG4gICAgICAgIGhlYWRlci5tZXNzYWdlSUQgPSBkYXRhLnJlYWREb3VibGVCRShpbmRleCk7XHJcblxyXG4gICAgICAgIHJldHVybiBoZWFkZXI7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiDlj5HpgIHmlbDmja7jgILlj5HpgIHlpLHotKXnm7TmjqXmipvlh7rlvILluLhcclxuICAgICAqIFxyXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1lc3NhZ2VOYW1lIOa2iOaBr+eahOWQjeensCjmoIfpopgpXHJcbiAgICAgKiBAcGFyYW0geyhhbnlbXSB8IEJ1ZmZlcil9IFtkYXRhPVtdXSDopoHlj5HpgIHnmoTmlbDmja7jgILlpoLmnpzmmK/kvKDlhaXnmoTmmK/mlbDnu4TvvIzliJnmlbDmja7lsIbkvb/nlKhCYXNlU29ja2V0LnNlcmlhbGl6ZSgpIOi/m+ihjOW6j+WIl+WMluOAguWmguaenOS8oOWFpeeahOaYr0J1ZmZlcu+8jOWImeWwhuebtOaOpeiiq+WPkemAgeOAgijms6jmhI/vvJrkvKDlhaXnmoRCdWZmZXLlv4XpobvmmK9CYXNlU29ja2V0LnNlcmlhbGl6ZSgp5Lqn55Sf55qEKVxyXG4gICAgICogQHBhcmFtIHtib29sZWFufSBbbmVlZEFDSz10cnVlXSDlj5Hlh7rnmoTov5nmnaHmtojmga/mmK/lkKbpnIDopoHnoa7orqTlr7nmlrnmmK/lkKblt7Lnu4/mlLbliLBcclxuICAgICAqIEBwYXJhbSB7Ym9vbGVhbn0gW3ByaW9yPWZhbHNlXSDmmK/lkKbnm7TmjqXlj5HpgIHvvIjkuI3lnKjnvJPlhrLpmJ/liJfkuK3mjpLpmJ/jgILpu5jorqRmYWxzZe+8iVxyXG4gICAgICogQHJldHVybnMgeyhQcm9taXNlPHZvaWQ+ICYgeyBtZXNzYWdlSUQ6IG51bWJlciB9KX0gbWVzc2FnZUlEXHJcbiAgICAgKiBAbWVtYmVyb2YgQmFzZVNvY2tldFxyXG4gICAgICovXHJcbiAgICBzZW5kKG1lc3NhZ2VOYW1lOiBzdHJpbmcsIGRhdGE6IGFueVtdIHwgQnVmZmVyID0gW10sIG5lZWRBQ0s6IGJvb2xlYW4gPSB0cnVlLCBwcmlvcjogYm9vbGVhbiA9IGZhbHNlKSB7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMuX3NlbmQoZmFsc2UsIHByaW9yLCBtZXNzYWdlTmFtZSwgbmVlZEFDSywgZGF0YSk7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgICog5Y+R6YCB5YaF6YOo5pWw5o2u44CC5Y+R6YCB5aSx6LSl55u05o6l5oqb5Ye65byC5bi444CC5YaF6YOo5pWw5o2u6buY6K6k5LiN6ZyA6KaB5o6l5pS256uv56Gu6K6kIO+8jOW5tuS4lOm7mOiupOS8mOWFiOWPkemAgSAgICAgXHJcbiAgICAgICog5rOo5oSP77ya6KaB5Zyo5q+P5LiA5Liq6LCD55So55qE5Zyw5pa55YGa5aW95byC5bi45aSE55CGXHJcbiAgICAgICovXHJcbiAgICBwcm90ZWN0ZWQgX3NlbmRJbnRlcm5hbChtZXNzYWdlTmFtZTogc3RyaW5nLCBkYXRhOiBhbnlbXSB8IEJ1ZmZlciA9IFtdLCBuZWVkQUNLOiBib29sZWFuID0gZmFsc2UsIHByaW9yOiBib29sZWFuID0gdHJ1ZSkge1xyXG4gICAgICAgIHJldHVybiB0aGlzLl9zZW5kKHRydWUsIHByaW9yLCBtZXNzYWdlTmFtZSwgbmVlZEFDSywgZGF0YSk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBfc2VuZChpc0ludGVybmFsOiBib29sZWFuLCBwcmlvcjogYm9vbGVhbiwgbWVzc2FnZU5hbWU6IHN0cmluZywgbmVlZEFDSzogYm9vbGVhbiwgZGF0YTogYW55W10gfCBCdWZmZXIpOiBQcm9taXNlPHZvaWQ+ICYgeyBtZXNzYWdlSUQ6IG51bWJlciB9IHtcclxuICAgICAgICBjb25zdCBtc2dJRCA9IHRoaXMuX21lc3NhZ2VJRCsrO1xyXG4gICAgICAgIGNvbnN0IHByb206IGFueSA9IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgaGVhZGVyID0gdGhpcy5fc2VyaWFsaXplSGVhZGVyKGlzSW50ZXJuYWwsIG1lc3NhZ2VOYW1lLCBuZWVkQUNLLCBtc2dJRCk7XHJcblxyXG4gICAgICAgICAgICBsZXQgc2VuZGluZ0RhdGE6IEJ1ZmZlcjsgICAgLy/opoHlj5HpgIHnmoTmlbDmja5cclxuICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcclxuICAgICAgICAgICAgICAgIHNlbmRpbmdEYXRhID0gX0J1ZmZlci5jb25jYXQoW2hlYWRlciwgQmFzZVNvY2tldC5zZXJpYWxpemUoZGF0YSldKTtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChpc0J1ZmZlcihkYXRhKSkge1xyXG4gICAgICAgICAgICAgICAgaWYgKCg8YW55PmRhdGEpLl9zZXJpYWxpemVkKVxyXG4gICAgICAgICAgICAgICAgICAgIHNlbmRpbmdEYXRhID0gX0J1ZmZlci5jb25jYXQoW2hlYWRlciwgZGF0YV0pO1xyXG4gICAgICAgICAgICAgICAgZWxzZVxyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign6KaB6KKr5Y+R6YCB55qEQnVmZmVy5bm25LiN5pivQmFzZVNvY2tldC5zZXJpYWxpemUoKeW6j+WIl+WMluS6p+eUn+eahCcpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDkvKDlhaXnmoTmlbDmja7nsbvlnovlrZjlnKjpl67popjvvIzlv4XpobvmmK/mlbDnu4TmiJZCdWZmZXLvvIzogIzlrp7pmYXnsbvlnovmmK/vvJoke09iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChkYXRhKX1gKTtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgaWYgKHRoaXMuX21heFBheWxvYWQgIT09IHVuZGVmaW5lZCAmJiBzZW5kaW5nRGF0YS5sZW5ndGggPiB0aGlzLl9tYXhQYXlsb2FkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+WPkemAgeeahOaVsOaNruWkp+Wwj+i2hei/h+S6humZkOWIticpO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBjb25zdCBjb250cm9sOiBRdWV1ZURhdGEgPSB7XHJcbiAgICAgICAgICAgICAgICBkYXRhOiBzZW5kaW5nRGF0YSxcclxuICAgICAgICAgICAgICAgIG1lc3NhZ2VJRDogbXNnSUQsXHJcbiAgICAgICAgICAgICAgICBzZW50OiBmYWxzZSxcclxuICAgICAgICAgICAgICAgIGNhbmNlbDogKGVycikgPT4geyAgLy/ov5jmnKrlj5HpgIHkuYvliY3miY3lj6/ku6Xlj5bmtohcclxuICAgICAgICAgICAgICAgICAgICBpZiAoY29udHJvbC5zZW50KVxyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgICAgICAgICAgZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3F1ZXVlLmRlbGV0ZShtc2dJRCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGVyciA/IHJlamVjdChlcnIpIDogcmVzb2x2ZSgpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICAgICAgc2VuZDogKCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChjb250cm9sLnNlbnQpIHJldHVybjsgICAvL+mBv+WFjemHjeWkjeWPkemAgVxyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRyb2wuc2VudCA9IHRydWU7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgIGlmIChuZWVkQUNLKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3NlbmREYXRhKHNlbmRpbmdEYXRhKS5jYXRjaChjb250cm9sLmFjayk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fc2VuZERhdGEoc2VuZGluZ0RhdGEpLnRoZW4oPGFueT5jb250cm9sLmFjaykuY2F0Y2goY29udHJvbC5hY2spO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgICAgICBhY2s6IChlcnIpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBpc0ZpcnN0ID0gdGhpcy5fcXVldWUudmFsdWVzKCkubmV4dCgpLnZhbHVlID09PSBjb250cm9sO1xyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3F1ZXVlLmRlbGV0ZShtc2dJRCk7XHJcbiAgICAgICAgICAgICAgICAgICAgZXJyID8gcmVqZWN0KGVycikgOiByZXNvbHZlKCk7XHJcblxyXG4gICAgICAgICAgICAgICAgICAgIGlmIChpc0ZpcnN0ICYmIHRoaXMuX3F1ZXVlLnNpemUgPiAwKSAgIC8v5aaC5p6c6Zif5YiX5Lit6L+Y5pyJ77yM5bm25LiU6Ieq5bex5L2N5LqO6Zif5YiX5aS06YOo77yI5Li76KaB6ZKI5a+5cHJpb3LnmoTmg4XlhrXvvInvvIzliJnlj5HpgIHkuIvkuIDmnaFcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcXVldWUudmFsdWVzKCkubmV4dCgpLnZhbHVlLnNlbmQoKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfTtcclxuXHJcbiAgICAgICAgICAgIHRoaXMuX3F1ZXVlLnNldChtc2dJRCwgY29udHJvbCk7ICAgIC8v5re75Yqg5Yiw6Zif5YiX5LitXHJcblxyXG4gICAgICAgICAgICBpZiAocHJpb3IgfHwgdGhpcy5fcXVldWUuc2l6ZSA9PT0gMSkgeyAgIC8v5aaC5p6c5Y+q5pyJ5Yia5Yia6K6+572u55qE6L+Z5LiA5p2hXHJcbiAgICAgICAgICAgICAgICBjb250cm9sLnNlbmQoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHByb20ubWVzc2FnZUlEID0gbXNnSUQ7XHJcbiAgICAgICAgcmV0dXJuIHByb207XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiDpnIDopoHlrZDnsbvopoblhpnjgILosIPnlKhfc29ja2V05Y+R6YCB5pWw5o2uXHJcbiAgICAgKiBcclxuICAgICAqIEBwcm90ZWN0ZWRcclxuICAgICAqIEBhYnN0cmFjdFxyXG4gICAgICogQHBhcmFtIHtCdWZmZXJ9IGRhdGEg6KaB5Y+R6YCB55qE5pWw5o2uXHJcbiAgICAgKiBAcmV0dXJucyB7UHJvbWlzZTx2b2lkPn0gXHJcbiAgICAgKiBAbWVtYmVyb2YgQmFzZVNvY2tldFxyXG4gICAgICovXHJcbiAgICBwcm90ZWN0ZWQgYWJzdHJhY3QgX3NlbmREYXRhKGRhdGE6IEJ1ZmZlcik6IFByb21pc2U8dm9pZD47XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiDop6PmnpDmjqXmlLbliLDmlbDmja7jgILlrZDnsbvmjqXmlLbliLDmtojmga/lkI7pnIDopoHop6blj5Hov5nkuKrmlrnms5VcclxuICAgICAqIFxyXG4gICAgICogQHByb3RlY3RlZFxyXG4gICAgICogQHBhcmFtIHtCdWZmZXJ9IGRhdGEg5o6l5pS25Yiw5pWw5o2uXHJcbiAgICAgKiBAbWVtYmVyb2YgQmFzZVNvY2tldFxyXG4gICAgICovXHJcbiAgICBwcm90ZWN0ZWQgX3JlY2VpdmVEYXRhKGRhdGE6IEJ1ZmZlcikge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGhlYWRlciA9IHRoaXMuX2Rlc2VyaWFsaXplSGVhZGVyKGRhdGEpO1xyXG4gICAgICAgICAgICAvL2NvbnNvbGUubG9nKGhlYWRlcilcclxuICAgICAgICAgICAgaWYgKGhlYWRlci5uZWVkQUNLKVxyXG4gICAgICAgICAgICAgICAgdGhpcy5fc2VuZEludGVybmFsKCdhY2snLCBbaGVhZGVyLm1lc3NhZ2VJRF0pLmNhdGNoKGVyciA9PiB0aGlzLmVtaXQoJ2Vycm9yJywgZXJyKSk7XHJcblxyXG4gICAgICAgICAgICBpZiAoaGVhZGVyLmlzSW50ZXJuYWwpIHsgICAgLy/lpoLmnpzmjqXmlLbliLDnmoTmmK/lhoXpg6jlj5HmnaXnmoTmtojmga9cclxuICAgICAgICAgICAgICAgIGNvbnN0IGJvZHkgPSBCYXNlU29ja2V0LmRlc2VyaWFsaXplKGRhdGEuc2xpY2UoaGVhZGVyLmhlYWRlckxlbmd0aCkpO1xyXG5cclxuICAgICAgICAgICAgICAgIHN3aXRjaCAoaGVhZGVyLm1lc3NhZ2VOYW1lKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnYWNrJzpcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgY2FsbGJhY2sgPSB0aGlzLl9xdWV1ZS5nZXQoYm9keVswXSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrICYmIGNhbGxiYWNrLmFjaygpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGJvZHkgPSB0aGlzLl9uZWVkRGVzZXJpYWxpemUgPyBCYXNlU29ja2V0LmRlc2VyaWFsaXplKGRhdGEuc2xpY2UoaGVhZGVyLmhlYWRlckxlbmd0aCkpIDogZGF0YS5zbGljZShoZWFkZXIuaGVhZGVyTGVuZ3RoKTtcclxuICAgICAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4geyAgLy/pgb/lhY3ooqvlpJblsYLnmoR0cnkgY2F0Y2jmjZXmjYnliLBcclxuICAgICAgICAgICAgICAgICAgICB0aGlzLmVtaXQoJ21lc3NhZ2UnLCBoZWFkZXIubWVzc2FnZU5hbWUsIGJvZHkpO1xyXG4gICAgICAgICAgICAgICAgfSwgMCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICB0aGlzLmVtaXQoJ2Vycm9yJywgZXJyb3IpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIOWPlua2iOWPkemAgeOAguWmguaenOafkOadoea2iOaBr+i/mOayoeacieiiq+WPlua2iOWImeWPr+S7peiiq+WPlua2iOOAguWPlua2iOaIkOWKn+i/lOWbnnRydWXvvIzlpLHotKVmYWxzZVxyXG4gICAgICogXHJcbiAgICAgKiBAcGFyYW0ge251bWJlcn0gbWVzc2FnZUlEIOimgeWPlua2iOWPkemAgea2iOaBr+eahG1lc3NhZ2VJRFxyXG4gICAgICogQHBhcmFtIHtFcnJvcn0gW2Vycl0g5Lyg6YCS5LiA5LiqZXJyb3LvvIzmjIfnpLrmnKzmrKHlj5HpgIHlsZ7kuo7lpLHotKVcclxuICAgICAqIEByZXR1cm5zIHtib29sZWFufSDlj5bmtojmiJDlip/ov5Tlm550cnVl77yM5aSx6LSlZmFsc2VcclxuICAgICAqIEBtZW1iZXJvZiBCYXNlU29ja2V0XHJcbiAgICAgKi9cclxuICAgIGNhbmNlbChtZXNzYWdlSUQ6IG51bWJlciwgZXJyPzogRXJyb3IpOiBib29sZWFuIHtcclxuICAgICAgICBjb25zdCBjb250cm9sID0gdGhpcy5fcXVldWUuZ2V0KG1lc3NhZ2VJRCk7XHJcblxyXG4gICAgICAgIGlmIChjb250cm9sKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjb250cm9sLmNhbmNlbChlcnIpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICog5YWz6Zet5o6l5Y+j44CC5YWz6Zet5LmL5ZCO5Lya6Kem5Y+RY2xvc2Xkuovku7ZcclxuICAgICAqIFxyXG4gICAgICogQGFic3RyYWN0XHJcbiAgICAgKiBAcmV0dXJucyB7dm9pZH0gXHJcbiAgICAgKiBAbWVtYmVyb2YgQmFzZVNvY2tldFxyXG4gICAgICovXHJcbiAgICBhYnN0cmFjdCBjbG9zZSgpOiB2b2lkO1xyXG5cclxuICAgIG9uKGV2ZW50OiAnZXJyb3InLCBjYjogKGVycjogRXJyb3IpID0+IHZvaWQpOiB0aGlzXHJcbiAgICAvKipcclxuICAgICAqIOW9k+aUtuWIsOa2iOaBr1xyXG4gICAgICovXHJcbiAgICBvbihldmVudDogJ21lc3NhZ2UnLCBjYjogKG1lc3NhZ2VOYW1lOiBzdHJpbmcsIGRhdGE6IGFueVtdIHwgQnVmZmVyKSA9PiB2b2lkKTogdGhpc1xyXG4gICAgLyoqXHJcbiAgICAgKiDlvZPov57mjqXlu7rnq4tcclxuICAgICAqL1xyXG4gICAgb24oZXZlbnQ6ICdvcGVuJywgY2I6ICgpID0+IHZvaWQpOiB0aGlzXHJcbiAgICAvKipcclxuICAgICAqIOaWreW8gOi/nuaOpVxyXG4gICAgICovXHJcbiAgICBvbihldmVudDogJ2Nsb3NlJywgY2I6IChjb2RlOiBudW1iZXIsIHJlYXNvbjogc3RyaW5nKSA9PiB2b2lkKTogdGhpc1xyXG4gICAgb24oZXZlbnQ6IHN0cmluZywgbGlzdGVuZXI6IEZ1bmN0aW9uKTogdGhpcyB7XHJcbiAgICAgICAgc3VwZXIub24oZXZlbnQsIGxpc3RlbmVyKTtcclxuICAgICAgICByZXR1cm4gdGhpcztcclxuICAgIH1cclxuXHJcbiAgICBvbmNlKGV2ZW50OiAnZXJyb3InLCBjYjogKGVycjogRXJyb3IpID0+IHZvaWQpOiB0aGlzXHJcbiAgICAvKipcclxuICAgICAqIOW9k+aUtuWIsOa2iOaBr1xyXG4gICAgICovXHJcbiAgICBvbmNlKGV2ZW50OiAnbWVzc2FnZScsIGNiOiAobWVzc2FnZU5hbWU6IHN0cmluZywgZGF0YTogYW55W10gfCBCdWZmZXIpID0+IHZvaWQpOiB0aGlzXHJcbiAgICAvKipcclxuICAgICAqIOW9k+i/nuaOpeW7uueri1xyXG4gICAgICovXHJcbiAgICBvbmNlKGV2ZW50OiAnb3BlbicsIGNiOiAoKSA9PiB2b2lkKTogdGhpc1xyXG4gICAgb25jZShldmVudDogJ2Nsb3NlJywgY2I6IChjb2RlOiBudW1iZXIsIHJlYXNvbjogc3RyaW5nKSA9PiB2b2lkKTogdGhpc1xyXG4gICAgb25jZShldmVudDogc3RyaW5nLCBsaXN0ZW5lcjogRnVuY3Rpb24pOiB0aGlzIHtcclxuICAgICAgICBzdXBlci5vbmNlKGV2ZW50LCBsaXN0ZW5lcik7XHJcbiAgICAgICAgcmV0dXJuIHRoaXM7XHJcbiAgICB9XHJcbn0iXX0=
