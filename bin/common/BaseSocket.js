"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Emitter = require("component-emitter");
const object2buffer_1 = require("object2buffer");
/**
 * Socket 接口的抽象类，定义了socket需要实现的基础功能
 */
class BaseSocket extends Emitter {
    constructor(configs) {
        super();
        /**
         * _messageID 的ID号，id从0开始。每发一条消息，该id加1
         */
        this._messageID = 0;
        /**
         * 等待发送消息的队列。key：messageID。
         */
        this._queue = new Map();
        this.url = configs.url;
        this._needDeserialize = configs.needDeserialize === undefined ? true : configs.needDeserialize;
        this._maxPayload = configs.maxPayload === undefined ? 1024 * 1024 * 100 : configs.maxPayload;
        if (configs.socket === undefined)
            throw new Error('传入BaseSocket的configs.socket不可以为空');
        else
            this._socket = configs.socket;
        this.once('close', () => {
            for (let item of [...this._queue.values()].reverse()) {
                const result = item.cancel(new Error('连接中断'));
                if (result === false)
                    item.ack(new Error('连接中断')); //取消正在发送的
            }
        });
    }
    /**
     * 连接的当前状态
     */
    get readyState() {
        return this._socket.readyState;
    }
    /**
     * 在缓冲队列中等待发送的数据字节数
     */
    get bufferedAmount() {
        let size = 0;
        for (let item of this._queue.values()) {
            size += item.data.length;
        }
        return size;
    }
    /**
     * 序列化消息头部。
     *
     * @private
     * @param {boolean} isInternal 是否是内部消息
     * @param {dataType} messageName 消息的名称
     * @param {boolean} needACK
     * @param {number} messageID
     * @returns {Buffer}
     * @memberof BaseSocket
     */
    _serializeHeader(isInternal, messageName, needACK, messageID) {
        const header = object2buffer_1.serialize([isInternal, needACK, messageID, messageName]);
        const headerLength = object2buffer_1.NodeBuffer.alloc(8);
        headerLength.writeDoubleBE(header.length, 0);
        return object2buffer_1.NodeBuffer.concat([headerLength, header]);
    }
    /**
     * 反序列化头部
     */
    _deserializeHeader(data) {
        const headerLength = data.readDoubleBE(0);
        const header = object2buffer_1.deserialize(data.slice(8, headerLength + 8));
        return {
            isInternal: header[0],
            needACK: header[1],
            messageID: header[2],
            messageName: header[3],
            headerLength: 8 + headerLength
        };
    }
    /**
     * 发送数据。发送失败直接抛出异常
     *
     * @param {dataType} messageName 消息的名称(标题)
     * @param {dataType[]} [data=[]] 要发送的数据。如果是传入的是数组，则数据将使用object2buffer进行序列化。如果传入的是Buffer，则将直接被发送。(注意：传入的Buffer如果不是object2buffer序列化产生的，则需要接收方设置needDeserialize = false)
     * @param {boolean} [needACK=true] 发出的这条消息是否需要确认对方是否已经收到
     * @param {boolean} [prior=false] 是否直接发送（在缓冲队列中排队。默认false）
     * @returns {(Promise<void> & { messageID: number })} messageID
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
            if (Array.isArray(data))
                sendingData = object2buffer_1.NodeBuffer.concat([header, object2buffer_1.serialize(data)]);
            else
                sendingData = object2buffer_1.NodeBuffer.concat([header, data]);
            if (sendingData.length >= this._maxPayload)
                throw new Error('发送的数据大小超过了限制');
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
            if (header.needACK)
                this._sendInternal('ack', [header.messageID]).catch(err => this.emit('error', err));
            if (header.isInternal) {
                const body = object2buffer_1.deserialize(data.slice(header.headerLength));
                switch (header.messageName) {
                    case 'ack':
                        const callback = this._queue.get(body[0]);
                        callback && callback.ack();
                        break;
                }
            }
            else {
                const body = this._needDeserialize ? object2buffer_1.deserialize(data.slice(header.headerLength)) : data.slice(header.headerLength);
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
     * 取消发送。如果某条消息还没有被发送则可以被取消。取消成功返回true，失败false
     *
     * @param {number} messageID 要取消发送消息的messageID
     * @param {Error} [err] 传递一个error，指示本次发送失败的原因
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

//# sourceMappingURL=data:application/json;charset=utf8;base64,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U0FBUyxFQUFFLE1BQU0sQ0FBQyxXQUFXLEVBQUUsSUFBSSxDQUFDLENBQUM7Z0JBQ25ELENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztZQUNWLENBQUM7UUFDTCxDQUFDO1FBQUMsS0FBSyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztZQUNiLElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQzlCLENBQUM7SUFDTCxDQUFDO0lBRUQ7Ozs7Ozs7T0FPRztJQUNILE1BQU0sQ0FBQyxTQUFpQixFQUFFLEdBQVc7UUFDakMsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUM7UUFFM0MsRUFBRSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztZQUNWLE1BQU0sQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQy9CLENBQUM7UUFFRCxNQUFNLENBQUMsS0FBSyxDQUFDO0lBQ2pCLENBQUM7SUF3QkQsRUFBRSxDQUFDLEtBQWEsRUFBRSxRQUFrQjtRQUNoQyxLQUFLLENBQUMsRUFBRSxDQUFDLEtBQUssRUFBRSxRQUFRLENBQUMsQ0FBQztRQUMxQixNQUFNLENBQUMsSUFBSSxDQUFDO0lBQ2hCLENBQUM7SUFNRCxJQUFJLENBQUMsS0FBYSxFQUFFLFFBQWtCO1FBQ2xDLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxFQUFFLFFBQVEsQ0FBQyxDQUFDO1FBQzVCLE1BQU0sQ0FBQyxJQUFJLENBQUM7SUFDaEIsQ0FBQztDQUNKO0FBeFJELGdDQXdSQyIsImZpbGUiOiJjb21tb24vQmFzZVNvY2tldC5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIEVtaXR0ZXIgZnJvbSAnY29tcG9uZW50LWVtaXR0ZXInO1xyXG5pbXBvcnQgKiBhcyBXUyBmcm9tICd3cyc7XHJcbmltcG9ydCB7IHNlcmlhbGl6ZSwgZGVzZXJpYWxpemUsIE5vZGVCdWZmZXIgfSBmcm9tICdvYmplY3QyYnVmZmVyJztcclxuaW1wb3J0IHsgZGF0YVR5cGUgfSBmcm9tICdvYmplY3QyYnVmZmVyL3NyYy9EYXRhVHlwZSc7XHJcblxyXG5pbXBvcnQgeyBSZWFkeVN0YXRlIH0gZnJvbSBcIi4vUmVhZHlTdGF0ZVwiO1xyXG5pbXBvcnQgeyBCYXNlU29ja2V0Q29uZmlnIH0gZnJvbSAnLi9CYXNlU29ja2V0Q29uZmlnJztcclxuaW1wb3J0IHsgUXVldWVEYXRhIH0gZnJvbSAnLi9RdWV1ZURhdGEnO1xyXG5cclxuLyoqXHJcbiAqIFNvY2tldCDmjqXlj6PnmoTmir3osaHnsbvvvIzlrprkuYnkuoZzb2NrZXTpnIDopoHlrp7njrDnmoTln7rnoYDlip/og71cclxuICovXHJcbmV4cG9ydCBhYnN0cmFjdCBjbGFzcyBCYXNlU29ja2V0IGV4dGVuZHMgRW1pdHRlciB7XHJcbiAgICAvKipcclxuICAgICAqIF9tZXNzYWdlSUQg55qESUTlj7fvvIxpZOS7jjDlvIDlp4vjgILmr4/lj5HkuIDmnaHmtojmga/vvIzor6VpZOWKoDFcclxuICAgICAqL1xyXG4gICAgcHJpdmF0ZSBfbWVzc2FnZUlEID0gMDtcclxuXHJcbiAgICBwcml2YXRlIHJlYWRvbmx5IF9uZWVkRGVzZXJpYWxpemU6IGJvb2xlYW47XHJcblxyXG4gICAgcHJpdmF0ZSByZWFkb25seSBfbWF4UGF5bG9hZDogbnVtYmVyO1xyXG5cclxuICAgIC8qKlxyXG4gICAgICog562J5b6F5Y+R6YCB5raI5oGv55qE6Zif5YiX44CCa2V577yabWVzc2FnZUlE44CCXHJcbiAgICAgKi9cclxuICAgIHByaXZhdGUgcmVhZG9ubHkgX3F1ZXVlOiBNYXA8bnVtYmVyLCBRdWV1ZURhdGE+ID0gbmV3IE1hcCgpO1xyXG5cclxuICAgIC8qKlxyXG4gICAgICog5L+d5a2Y6KKr5YyF6KOF55qEc29ja2V05a+56LGhXHJcbiAgICAgKi9cclxuICAgIHJlYWRvbmx5IF9zb2NrZXQ6IFdlYlNvY2tldCB8IFdTO1xyXG5cclxuICAgIC8qKlxyXG4gICAgICogV2ViU29ja2V0IHNlcnZlciDnmoRVUkzlnLDlnYAgICBcclxuICAgICAqIOazqOaEj++8muWmguaenOaYr1NlcnZlcueUn+aIkOeahFNvY2tldO+8jOWImXVybOS4uuepuuWtl+espuS4slxyXG4gICAgICovXHJcbiAgICByZWFkb25seSB1cmw6IHN0cmluZztcclxuXHJcbiAgICAvKipcclxuICAgICAqIOi/nuaOpeeahOW9k+WJjeeKtuaAgVxyXG4gICAgICovXHJcbiAgICBnZXQgcmVhZHlTdGF0ZSgpOiBSZWFkeVN0YXRlIHtcclxuICAgICAgICByZXR1cm4gdGhpcy5fc29ja2V0LnJlYWR5U3RhdGU7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiDlnKjnvJPlhrLpmJ/liJfkuK3nrYnlvoXlj5HpgIHnmoTmlbDmja7lrZfoioLmlbBcclxuICAgICAqL1xyXG4gICAgZ2V0IGJ1ZmZlcmVkQW1vdW50KCk6IG51bWJlciB7XHJcbiAgICAgICAgbGV0IHNpemUgPSAwO1xyXG5cclxuICAgICAgICBmb3IgKGxldCBpdGVtIG9mIHRoaXMuX3F1ZXVlLnZhbHVlcygpKSB7XHJcbiAgICAgICAgICAgIHNpemUgKz0gaXRlbS5kYXRhLmxlbmd0aDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHJldHVybiBzaXplO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0cnVjdG9yKGNvbmZpZ3M6IEJhc2VTb2NrZXRDb25maWcpIHtcclxuICAgICAgICBzdXBlcigpO1xyXG5cclxuICAgICAgICB0aGlzLnVybCA9IGNvbmZpZ3MudXJsO1xyXG4gICAgICAgIHRoaXMuX25lZWREZXNlcmlhbGl6ZSA9IGNvbmZpZ3MubmVlZERlc2VyaWFsaXplID09PSB1bmRlZmluZWQgPyB0cnVlIDogY29uZmlncy5uZWVkRGVzZXJpYWxpemU7XHJcbiAgICAgICAgdGhpcy5fbWF4UGF5bG9hZCA9IGNvbmZpZ3MubWF4UGF5bG9hZCA9PT0gdW5kZWZpbmVkID8gMTAyNCAqIDEwMjQgKiAxMDAgOiBjb25maWdzLm1heFBheWxvYWQ7XHJcblxyXG4gICAgICAgIGlmIChjb25maWdzLnNvY2tldCA9PT0gdW5kZWZpbmVkKVxyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+S8oOWFpUJhc2VTb2NrZXTnmoRjb25maWdzLnNvY2tldOS4jeWPr+S7peS4uuepuicpO1xyXG4gICAgICAgIGVsc2VcclxuICAgICAgICAgICAgdGhpcy5fc29ja2V0ID0gY29uZmlncy5zb2NrZXQ7XHJcblxyXG4gICAgICAgIHRoaXMub25jZSgnY2xvc2UnLCAoKSA9PiB7ICAgIC8v5aaC5p6c5pat5byA77yM57uI5q2i5omA5pyJ6L+Y5pyq5Y+R6YCB55qE5raI5oGvXHJcbiAgICAgICAgICAgIGZvciAobGV0IGl0ZW0gb2YgWy4uLnRoaXMuX3F1ZXVlLnZhbHVlcygpXS5yZXZlcnNlKCkpIHsgLy/ku47lkI7lkJHliY3lj5bmtohcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGl0ZW0uY2FuY2VsKG5ldyBFcnJvcign6L+e5o6l5Lit5patJykpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdCA9PT0gZmFsc2UpXHJcbiAgICAgICAgICAgICAgICAgICAgaXRlbS5hY2sobmV3IEVycm9yKCfov57mjqXkuK3mlq0nKSk7ICAgIC8v5Y+W5raI5q2j5Zyo5Y+R6YCB55qEXHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIOW6j+WIl+WMlua2iOaBr+WktOmDqOOAgiAgICBcclxuICAgICAqIFxyXG4gICAgICogQHByaXZhdGVcclxuICAgICAqIEBwYXJhbSB7Ym9vbGVhbn0gaXNJbnRlcm5hbCDmmK/lkKbmmK/lhoXpg6jmtojmga9cclxuICAgICAqIEBwYXJhbSB7ZGF0YVR5cGV9IG1lc3NhZ2VOYW1lIOa2iOaBr+eahOWQjeensFxyXG4gICAgICogQHBhcmFtIHtib29sZWFufSBuZWVkQUNLIFxyXG4gICAgICogQHBhcmFtIHtudW1iZXJ9IG1lc3NhZ2VJRFxyXG4gICAgICogQHJldHVybnMge0J1ZmZlcn0gXHJcbiAgICAgKiBAbWVtYmVyb2YgQmFzZVNvY2tldFxyXG4gICAgICovXHJcbiAgICBwcml2YXRlIF9zZXJpYWxpemVIZWFkZXIoaXNJbnRlcm5hbDogYm9vbGVhbiwgbWVzc2FnZU5hbWU6IGRhdGFUeXBlLCBuZWVkQUNLOiBib29sZWFuLCBtZXNzYWdlSUQ6IG51bWJlcik6IEJ1ZmZlciB7XHJcbiAgICAgICAgY29uc3QgaGVhZGVyID0gc2VyaWFsaXplKFtpc0ludGVybmFsLCBuZWVkQUNLLCBtZXNzYWdlSUQsIG1lc3NhZ2VOYW1lXSk7XHJcbiAgICAgICAgY29uc3QgaGVhZGVyTGVuZ3RoID0gTm9kZUJ1ZmZlci5hbGxvYyg4KTtcclxuICAgICAgICBoZWFkZXJMZW5ndGgud3JpdGVEb3VibGVCRShoZWFkZXIubGVuZ3RoLCAwKTtcclxuXHJcbiAgICAgICAgcmV0dXJuIE5vZGVCdWZmZXIuY29uY2F0KFtoZWFkZXJMZW5ndGgsIGhlYWRlcl0pO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICog5Y+N5bqP5YiX5YyW5aS06YOoXHJcbiAgICAgKi9cclxuICAgIHByaXZhdGUgX2Rlc2VyaWFsaXplSGVhZGVyKGRhdGE6IEJ1ZmZlcikge1xyXG4gICAgICAgIGNvbnN0IGhlYWRlckxlbmd0aCA9IGRhdGEucmVhZERvdWJsZUJFKDApO1xyXG4gICAgICAgIGNvbnN0IGhlYWRlciA9IGRlc2VyaWFsaXplKGRhdGEuc2xpY2UoOCwgaGVhZGVyTGVuZ3RoICsgOCkpO1xyXG5cclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBpc0ludGVybmFsOiBoZWFkZXJbMF0gYXMgYm9vbGVhbixcclxuICAgICAgICAgICAgbmVlZEFDSzogaGVhZGVyWzFdIGFzIGJvb2xlYW4sXHJcbiAgICAgICAgICAgIG1lc3NhZ2VJRDogaGVhZGVyWzJdIGFzIG51bWJlcixcclxuICAgICAgICAgICAgbWVzc2FnZU5hbWU6IGhlYWRlclszXSxcclxuICAgICAgICAgICAgaGVhZGVyTGVuZ3RoOiA4ICsgaGVhZGVyTGVuZ3RoXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIOWPkemAgeaVsOaNruOAguWPkemAgeWksei0peebtOaOpeaKm+WHuuW8guW4uFxyXG4gICAgICogXHJcbiAgICAgKiBAcGFyYW0ge2RhdGFUeXBlfSBtZXNzYWdlTmFtZSDmtojmga/nmoTlkI3np7Ao5qCH6aKYKVxyXG4gICAgICogQHBhcmFtIHtkYXRhVHlwZVtdfSBbZGF0YT1bXV0g6KaB5Y+R6YCB55qE5pWw5o2u44CC5aaC5p6c5piv5Lyg5YWl55qE5piv5pWw57uE77yM5YiZ5pWw5o2u5bCG5L2/55Sob2JqZWN0MmJ1ZmZlcui/m+ihjOW6j+WIl+WMluOAguWmguaenOS8oOWFpeeahOaYr0J1ZmZlcu+8jOWImeWwhuebtOaOpeiiq+WPkemAgeOAgijms6jmhI/vvJrkvKDlhaXnmoRCdWZmZXLlpoLmnpzkuI3mmK9vYmplY3QyYnVmZmVy5bqP5YiX5YyW5Lqn55Sf55qE77yM5YiZ6ZyA6KaB5o6l5pS25pa56K6+572ubmVlZERlc2VyaWFsaXplID0gZmFsc2UpXHJcbiAgICAgKiBAcGFyYW0ge2Jvb2xlYW59IFtuZWVkQUNLPXRydWVdIOWPkeWHuueahOi/meadoea2iOaBr+aYr+WQpumcgOimgeehruiupOWvueaWueaYr+WQpuW3sue7j+aUtuWIsFxyXG4gICAgICogQHBhcmFtIHtib29sZWFufSBbcHJpb3I9ZmFsc2VdIOaYr+WQpuebtOaOpeWPkemAge+8iOWcqOe8k+WGsumYn+WIl+S4reaOkumYn+OAgum7mOiupGZhbHNl77yJXHJcbiAgICAgKiBAcmV0dXJucyB7KFByb21pc2U8dm9pZD4gJiB7IG1lc3NhZ2VJRDogbnVtYmVyIH0pfSBtZXNzYWdlSURcclxuICAgICAqL1xyXG4gICAgc2VuZChtZXNzYWdlTmFtZTogZGF0YVR5cGUsIGRhdGE6IGRhdGFUeXBlW10gfCBCdWZmZXIgPSBbXSwgbmVlZEFDSzogYm9vbGVhbiA9IHRydWUsIHByaW9yOiBib29sZWFuID0gZmFsc2UpIHtcclxuICAgICAgICByZXR1cm4gdGhpcy5fc2VuZChmYWxzZSwgcHJpb3IsIG1lc3NhZ2VOYW1lLCBuZWVkQUNLLCBkYXRhKTtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAgKiDlj5HpgIHlhoXpg6jmlbDmja7jgILlj5HpgIHlpLHotKXnm7TmjqXmipvlh7rlvILluLjjgILlhoXpg6jmlbDmja7pu5jorqTkuI3pnIDopoHmjqXmlLbnq6/noa7orqQg77yM5bm25LiU6buY6K6k5LyY5YWI5Y+R6YCBICAgICBcclxuICAgICAgKiDms6jmhI/vvJropoHlnKjmr4/kuIDkuKrosIPnlKjnmoTlnLDmlrnlgZrlpb3lvILluLjlpITnkIZcclxuICAgICAgKi9cclxuICAgIHByb3RlY3RlZCBfc2VuZEludGVybmFsKG1lc3NhZ2VOYW1lOiBkYXRhVHlwZSwgZGF0YTogZGF0YVR5cGVbXSB8IEJ1ZmZlciA9IFtdLCBuZWVkQUNLOiBib29sZWFuID0gZmFsc2UsIHByaW9yOiBib29sZWFuID0gdHJ1ZSkge1xyXG4gICAgICAgIHJldHVybiB0aGlzLl9zZW5kKHRydWUsIHByaW9yLCBtZXNzYWdlTmFtZSwgbmVlZEFDSywgZGF0YSk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBfc2VuZChpc0ludGVybmFsOiBib29sZWFuLCBwcmlvcjogYm9vbGVhbiwgbWVzc2FnZU5hbWU6IGRhdGFUeXBlLCBuZWVkQUNLOiBib29sZWFuLCBkYXRhOiBkYXRhVHlwZVtdIHwgQnVmZmVyKTogUHJvbWlzZTx2b2lkPiAmIHsgbWVzc2FnZUlEOiBudW1iZXIgfSB7XHJcbiAgICAgICAgY29uc3QgbXNnSUQgPSB0aGlzLl9tZXNzYWdlSUQrKztcclxuXHJcbiAgICAgICAgY29uc3QgcHJvbTogYW55ID0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBoZWFkZXIgPSB0aGlzLl9zZXJpYWxpemVIZWFkZXIoaXNJbnRlcm5hbCwgbWVzc2FnZU5hbWUsIG5lZWRBQ0ssIG1zZ0lEKTtcclxuXHJcbiAgICAgICAgICAgIGxldCBzZW5kaW5nRGF0YTogQnVmZmVyOyAgICAvL+imgeWPkemAgeeahOaVsOaNrlxyXG4gICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSlcclxuICAgICAgICAgICAgICAgIHNlbmRpbmdEYXRhID0gTm9kZUJ1ZmZlci5jb25jYXQoW2hlYWRlciwgc2VyaWFsaXplKGRhdGEpXSk7XHJcbiAgICAgICAgICAgIGVsc2VcclxuICAgICAgICAgICAgICAgIHNlbmRpbmdEYXRhID0gTm9kZUJ1ZmZlci5jb25jYXQoW2hlYWRlciwgZGF0YV0pO1xyXG5cclxuICAgICAgICAgICAgaWYgKHNlbmRpbmdEYXRhLmxlbmd0aCA+PSB0aGlzLl9tYXhQYXlsb2FkKVxyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflj5HpgIHnmoTmlbDmja7lpKflsI/otoXov4fkuobpmZDliLYnKTtcclxuXHJcbiAgICAgICAgICAgIGNvbnN0IGNvbnRyb2w6IFF1ZXVlRGF0YSA9IHtcclxuICAgICAgICAgICAgICAgIGRhdGE6IHNlbmRpbmdEYXRhLFxyXG4gICAgICAgICAgICAgICAgbWVzc2FnZUlEOiBtc2dJRCxcclxuICAgICAgICAgICAgICAgIHNlbnQ6IGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgY2FuY2VsOiAoZXJyKSA9PiB7ICAvL+i/mOacquWPkemAgeS5i+WJjeaJjeWPr+S7peWPlua2iFxyXG4gICAgICAgICAgICAgICAgICAgIGlmIChjb250cm9sLnNlbnQpXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICAgICAgICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcXVldWUuZGVsZXRlKG1zZ0lEKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZXJyID8gcmVqZWN0KGVycikgOiByZXNvbHZlKCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgICAgICBzZW5kOiAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbnRyb2wuc2VudCkgcmV0dXJuOyAgIC8v6YG/5YWN6YeN5aSN5Y+R6YCBXHJcbiAgICAgICAgICAgICAgICAgICAgY29udHJvbC5zZW50ID0gdHJ1ZTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKG5lZWRBQ0spIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fc2VuZERhdGEoc2VuZGluZ0RhdGEpLmNhdGNoKGNvbnRyb2wuYWNrKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9zZW5kRGF0YShzZW5kaW5nRGF0YSkudGhlbig8YW55PmNvbnRyb2wuYWNrKS5jYXRjaChjb250cm9sLmFjayk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgIGFjazogKGVycikgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGlzRmlyc3QgPSB0aGlzLl9xdWV1ZS52YWx1ZXMoKS5uZXh0KCkudmFsdWUgPT09IGNvbnRyb2w7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcXVldWUuZGVsZXRlKG1zZ0lEKTtcclxuICAgICAgICAgICAgICAgICAgICBlcnIgPyByZWplY3QoZXJyKSA6IHJlc29sdmUoKTtcclxuXHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGlzRmlyc3QgJiYgdGhpcy5fcXVldWUuc2l6ZSA+IDApICAgLy/lpoLmnpzpmJ/liJfkuK3ov5jmnInvvIzlubbkuJToh6rlt7HkvY3kuo7pmJ/liJflpLTpg6jvvIjkuLvopoHpkojlr7lwcmlvcueahOaDheWGte+8ie+8jOWImeWPkemAgeS4i+S4gOadoVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9xdWV1ZS52YWx1ZXMoKS5uZXh0KCkudmFsdWUuc2VuZCgpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9O1xyXG5cclxuICAgICAgICAgICAgdGhpcy5fcXVldWUuc2V0KG1zZ0lELCBjb250cm9sKTsgICAgLy/mt7vliqDliLDpmJ/liJfkuK1cclxuXHJcbiAgICAgICAgICAgIGlmIChwcmlvciB8fCB0aGlzLl9xdWV1ZS5zaXplID09PSAxKSB7ICAgLy/lpoLmnpzlj6rmnInliJrliJrorr7nva7nmoTov5nkuIDmnaFcclxuICAgICAgICAgICAgICAgIGNvbnRyb2wuc2VuZCgpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIHByb20ubWVzc2FnZUlEID0gbXNnSUQ7XHJcbiAgICAgICAgcmV0dXJuIHByb207XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiDpnIDopoHlrZDnsbvopoblhpnjgILnlKjkuo7lj5HpgIHmlbDmja5cclxuICAgICAqIFxyXG4gICAgICogQHByb3RlY3RlZFxyXG4gICAgICogQGFic3RyYWN0XHJcbiAgICAgKiBAcGFyYW0ge0J1ZmZlcn0gZGF0YSDopoHlj5HpgIHnmoTmlbDmja5cclxuICAgICAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fSBcclxuICAgICAqIEBtZW1iZXJvZiBCYXNlU29ja2V0XHJcbiAgICAgKi9cclxuICAgIHByb3RlY3RlZCBhYnN0cmFjdCBfc2VuZERhdGEoZGF0YTogQnVmZmVyKTogUHJvbWlzZTx2b2lkPjtcclxuXHJcbiAgICAvKipcclxuICAgICAqIOino+aekOaOpeaUtuWIsOaVsOaNruOAguWtkOexu+aOpeaUtuWIsOa2iOaBr+WQjumcgOimgeinpuWPkei/meS4quaWueazlVxyXG4gICAgICogXHJcbiAgICAgKiBAcHJvdGVjdGVkXHJcbiAgICAgKiBAcGFyYW0ge0J1ZmZlcn0gZGF0YSDmjqXmlLbliLDmlbDmja5cclxuICAgICAqIEBtZW1iZXJvZiBCYXNlU29ja2V0XHJcbiAgICAgKi9cclxuICAgIHByb3RlY3RlZCBfcmVjZWl2ZURhdGEoZGF0YTogQnVmZmVyKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgaGVhZGVyID0gdGhpcy5fZGVzZXJpYWxpemVIZWFkZXIoZGF0YSk7XHJcblxyXG4gICAgICAgICAgICBpZiAoaGVhZGVyLm5lZWRBQ0spXHJcbiAgICAgICAgICAgICAgICB0aGlzLl9zZW5kSW50ZXJuYWwoJ2FjaycsIFtoZWFkZXIubWVzc2FnZUlEXSkuY2F0Y2goZXJyID0+IHRoaXMuZW1pdCgnZXJyb3InLCBlcnIpKTtcclxuXHJcbiAgICAgICAgICAgIGlmIChoZWFkZXIuaXNJbnRlcm5hbCkgeyAgICAvL+WmguaenOaOpeaUtuWIsOeahOaYr+WGhemDqOWPkeadpeeahOa2iOaBr1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYm9keSA9IGRlc2VyaWFsaXplKGRhdGEuc2xpY2UoaGVhZGVyLmhlYWRlckxlbmd0aCkpO1xyXG5cclxuICAgICAgICAgICAgICAgIHN3aXRjaCAoaGVhZGVyLm1lc3NhZ2VOYW1lKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY2FzZSAnYWNrJzpcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgY2FsbGJhY2sgPSB0aGlzLl9xdWV1ZS5nZXQoYm9keVswXSBhcyBudW1iZXIpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayAmJiBjYWxsYmFjay5hY2soKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBib2R5ID0gdGhpcy5fbmVlZERlc2VyaWFsaXplID8gZGVzZXJpYWxpemUoZGF0YS5zbGljZShoZWFkZXIuaGVhZGVyTGVuZ3RoKSkgOiBkYXRhLnNsaWNlKGhlYWRlci5oZWFkZXJMZW5ndGgpO1xyXG4gICAgICAgICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7ICAvL+mBv+WFjeiiq+WkluWxgueahHRyeSBjYXRjaOaNleaNieWIsFxyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuZW1pdCgnbWVzc2FnZScsIGhlYWRlci5tZXNzYWdlTmFtZSwgYm9keSk7XHJcbiAgICAgICAgICAgICAgICB9LCAwKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHRoaXMuZW1pdCgnZXJyb3InLCBlcnJvcik7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICog5Y+W5raI5Y+R6YCB44CC5aaC5p6c5p+Q5p2h5raI5oGv6L+Y5rKh5pyJ6KKr5Y+R6YCB5YiZ5Y+v5Lul6KKr5Y+W5raI44CC5Y+W5raI5oiQ5Yqf6L+U5ZuedHJ1Ze+8jOWksei0pWZhbHNlXHJcbiAgICAgKiBcclxuICAgICAqIEBwYXJhbSB7bnVtYmVyfSBtZXNzYWdlSUQg6KaB5Y+W5raI5Y+R6YCB5raI5oGv55qEbWVzc2FnZUlEXHJcbiAgICAgKiBAcGFyYW0ge0Vycm9yfSBbZXJyXSDkvKDpgJLkuIDkuKplcnJvcu+8jOaMh+ekuuacrOasoeWPkemAgeWksei0peeahOWOn+WboFxyXG4gICAgICogQHJldHVybnMge2Jvb2xlYW59IOWPlua2iOaIkOWKn+i/lOWbnnRydWXvvIzlpLHotKVmYWxzZVxyXG4gICAgICogQG1lbWJlcm9mIEJhc2VTb2NrZXRcclxuICAgICAqL1xyXG4gICAgY2FuY2VsKG1lc3NhZ2VJRDogbnVtYmVyLCBlcnI/OiBFcnJvcik6IGJvb2xlYW4ge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2wgPSB0aGlzLl9xdWV1ZS5nZXQobWVzc2FnZUlEKTtcclxuXHJcbiAgICAgICAgaWYgKGNvbnRyb2wpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNvbnRyb2wuY2FuY2VsKGVycik7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiDlhbPpl63mjqXlj6PjgILlhbPpl63kuYvlkI7kvJrop6blj5FjbG9zZeS6i+S7tlxyXG4gICAgICogXHJcbiAgICAgKiBAYWJzdHJhY3RcclxuICAgICAqIEByZXR1cm5zIHt2b2lkfSBcclxuICAgICAqIEBtZW1iZXJvZiBCYXNlU29ja2V0XHJcbiAgICAgKi9cclxuICAgIGFic3RyYWN0IGNsb3NlKCk6IHZvaWQ7XHJcblxyXG4gICAgb24oZXZlbnQ6ICdlcnJvcicsIGxpc3RlbmVyOiAoZXJyOiBFcnJvcikgPT4gdm9pZCk6IHRoaXNcclxuICAgIC8qKlxyXG4gICAgICog5b2T5pS25Yiw5raI5oGvXHJcbiAgICAgKi9cclxuICAgIG9uKGV2ZW50OiAnbWVzc2FnZScsIGxpc3RlbmVyOiAobWVzc2FnZU5hbWU6IHN0cmluZywgZGF0YTogYW55W10gfCBCdWZmZXIpID0+IHZvaWQpOiB0aGlzXHJcbiAgICAvKipcclxuICAgICAqIOW9k+i/nuaOpeW7uueri1xyXG4gICAgICovXHJcbiAgICBvbihldmVudDogJ29wZW4nLCBsaXN0ZW5lcjogKCkgPT4gdm9pZCk6IHRoaXNcclxuICAgIC8qKlxyXG4gICAgICog5pat5byA6L+e5o6lXHJcbiAgICAgKi9cclxuICAgIG9uKGV2ZW50OiAnY2xvc2UnLCBsaXN0ZW5lcjogKGNvZGU6IG51bWJlciwgcmVhc29uOiBzdHJpbmcpID0+IHZvaWQpOiB0aGlzXHJcbiAgICBvbihldmVudDogc3RyaW5nLCBsaXN0ZW5lcjogRnVuY3Rpb24pOiB0aGlzIHtcclxuICAgICAgICBzdXBlci5vbihldmVudCwgbGlzdGVuZXIpO1xyXG4gICAgICAgIHJldHVybiB0aGlzO1xyXG4gICAgfVxyXG5cclxuICAgIG9uY2UoZXZlbnQ6ICdlcnJvcicsIGxpc3RlbmVyOiAoZXJyOiBFcnJvcikgPT4gdm9pZCk6IHRoaXNcclxuICAgIG9uY2UoZXZlbnQ6ICdtZXNzYWdlJywgbGlzdGVuZXI6IChtZXNzYWdlTmFtZTogc3RyaW5nLCBkYXRhOiBhbnlbXSB8IEJ1ZmZlcikgPT4gdm9pZCk6IHRoaXNcclxuICAgIG9uY2UoZXZlbnQ6ICdvcGVuJywgbGlzdGVuZXI6ICgpID0+IHZvaWQpOiB0aGlzXHJcbiAgICBvbmNlKGV2ZW50OiAnY2xvc2UnLCBsaXN0ZW5lcjogKGNvZGU6IG51bWJlciwgcmVhc29uOiBzdHJpbmcpID0+IHZvaWQpOiB0aGlzXHJcbiAgICBvbmNlKGV2ZW50OiBzdHJpbmcsIGxpc3RlbmVyOiBGdW5jdGlvbik6IHRoaXMge1xyXG4gICAgICAgIHN1cGVyLm9uY2UoZXZlbnQsIGxpc3RlbmVyKTtcclxuICAgICAgICByZXR1cm4gdGhpcztcclxuICAgIH1cclxufSJdfQ==
