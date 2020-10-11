import setOnLoad from '../../lib/onloadPolyfill'

import {
  usernameInput,
  portInput,
  tunnelToggleButton,
  logWrapper,
  printAxiosProgress,
  generateHyperlink,
  enableInputs,
  disableInputs,
  refreshTunnelStatus,
  appendLog
} from './uiHelpers'

import {
  isLocalhostRoot,
  maxLogLength,
  maxStreamSize,
  serverProtocol,
  serverURL,
  socketTunnelURL,
  socketWatchURL,
  streamChunkSize
} from './constants'

import { inputHasErrors, containsFormdata } from './validators'
import { objectToArrayBuffer } from './parsers'

// State variables
let isTunnelling = false
/** @type {SocketIOClient.Socket} */
let socket

// Helper functions
const intitiateSocket = () => {
  socket = io.connect(socketTunnelURL, { path: '/sock' })
  socket.on('connect', () => socket.emit('username', usernameInput.value))
  socket.on('request', preprocessRequest)
}

/** @param {LocalhostTunnel.ClientRequest} serverRequest */
function preprocessRequest(serverRequest) {
  const { headers, requestId: formadataId } = serverRequest

  if (headers['range']) {
    const range = headers['range'].split('=')[1].split('-')
    if (!range[1])
      serverRequest.headers['range'] += parseInt(range[0]) + streamChunkSize
  }

  socket.on(formadataId, socketOnFileReceived)

  /** @type {Express.Multer.File[]} */
  var receivedFiles = []
  // , i = 0

  /** @param {Express.Multer.File} file */
  function socketOnFileReceived(file) {
    if (file.data && file.data === 'DONE') {
      socket.removeAllListeners(formadataId)
      serverRequest.files = receivedFiles
      // i++

      return tunnelLocalhostToServer(serverRequest)
    }

    receivedFiles.push(file)

    // TODO: chunk push and add acknowledgement delay
    // if (file.buffer) appendBuffer(receivedFiles[i].buffer, file.buffer)
    // else {
    //   receivedFiles[i] = file
    //   receivedFiles[i].buffer = new ArrayBuffer(file.size)
    // }
  }
}

/** @param {LocalhostTunnel.ClientRequest} req */
const makeRequestToLocalhost = req => {
  const { path, body, headers, method } = req
  const url = `${serverProtocol}//localhost:${portInput.value}${path}`

  /** @type {Axios.data} */
  const data = containsFormdata(headers) ? getFormdata(req) : body

  /** @type {Axios.RequestConfig} */
  const requestParameters = {
    headers,
    method,
    url,
    data,
    withCredentials: true,
    responseType: 'arraybuffer'
  }

  if (isLocalhostRoot)
    requestParameters.onUploadProgress = requestParameters.onDownloadProgress = e =>
      printAxiosProgress(e, url)

  return axios(requestParameters)
}

/** @param {LocalhostTunnel.ClientRequest} clientRequest */
async function tunnelLocalhostToServer(clientRequest) {
  const { path, requestId: responseId } = clientRequest

  try {
    /** @type {Axios.Response} */
    let localhostResponse
    try {
      localhostResponse = await makeRequestToLocalhost(clientRequest)
    } catch (localhostResponseError) {
      localhostResponse =
        /** @type {Axios.Error}*/ (localhostResponseError).response
    }

    const { status } = localhostResponse
    const method = localhostResponse.config.method.toUpperCase()
    const url = generateHyperlink(localhostResponse.config.url)
    const tunnelUrl = generateHyperlink(
      `${serverProtocol}//${serverURL}/${usernameInput.value}${path}`
    )
    appendLog(`${method} ${status} ${url} -> ${tunnelUrl}`)
    sendResponseToServer(localhostResponse, responseId)
  } catch (e) {
    // TODO: print in dev
    sendResponseToServer(
      {
        status: 500,
        statusText: '505 Client Error',
        config: {},
        headers: clientRequest.headers,
        data: objectToArrayBuffer({ message: '505 Client Error' })
      },
      responseId
    )
  }
}

/**
 * @param {Axios.Response} localhostResponse
 * @param {string} responseId
 */
function sendResponseToServer(localhostResponse, responseId) {
  const { status, headers, data, config } = localhostResponse
  const dataByteLength = data.byteLength

  const reqHeaders = /** @type {IncomingHttpHeaders}*/ (config.headers)

  // PARTIAL CONTENT
  if (status === 206) {
    const range = reqHeaders['range'].split('=')[1].split('-'),
      startByte = parseInt(range[0]),
      endByte = parseInt(range[1])

    headers['accept-ranges'] = 'bytes'
    headers['content-range'] = `bytes ${startByte}-${endByte}/${maxStreamSize}`

    // FIXME: I used a trick to fool browser. I'v set max size to 1GB
    // Download accelerators cannot open more than one connections
    // (maxStreamSize) should be total_length
    // can use an object to store prev total_length values
  }
  // TODO: REDIRECT
  else if ([301, 303, 307, 308].includes(status)) {
  }

  socket.emit(responseId, { status, headers, dataByteLength })

  const totalChunks = Math.ceil(dataByteLength / streamChunkSize)
  let startByte = 0,
    endByte = 0,
    chunk = new ArrayBuffer(0),
    i = 0

  // TODO: on ('CONTINUE.id')
  const sendChunkedResponse = () => {
    if (i === totalChunks) {
      socket.emit(responseId, { data: 'DONE' })
      return socket.removeAllListeners(responseId)
    }

    startByte = i * streamChunkSize
    endByte = startByte + streamChunkSize
    chunk = data.slice(startByte, endByte)

    socket.emit(responseId, { data: chunk })

    i++
  }
  socket.on(responseId, sendChunkedResponse)
}

/** @param {LocalhostTunnel.ClientRequest} req */
function getFormdata(req) {
  const fieldNames = Object.keys(req.body)
  let fieldName, file, mime, fileName

  const data = new FormData()
  for (let i = 0; i < fieldNames.length; i++) {
    fieldName = fieldNames[i]
    data.append(fieldName, req.body[fieldName])
  }

  for (let i = 0; i < req.files.length; i++) {
    file = req.files[i]
    fieldName = file.fieldname
    mime = file.mimetype
    fileName = file.originalname
    data.append(fieldName, new Blob([file.buffer], { type: mime }), fileName)
  }

  return data
}

// UI helper functions


function toggleTunnel() {
  if (isTunnelling) socket.disconnect()
  else intitiateSocket()

  isTunnelling = !isTunnelling
  refreshTunnelStatus(isTunnelling)
}

/** @param {Event} e */
async function onButtonClick(e) {
  e.preventDefault()

  if (isTunnelling) {
    toggleTunnel()
    enableInputs()
  } else {
    const error = await inputHasErrors()
    if (error) appendLog(error)
    else {
      toggleTunnel()
      disableInputs()
    }
  }
}

// main
setOnLoad(window, () => {
  refreshTunnelStatus(false)
  tunnelToggleButton.addEventListener('click', onButtonClick) // TODO: polyfill

  // if currently in localhost root, refresh page on file change
  if (isLocalhostRoot)
    io.connect(socketWatchURL, { path: '/sock' }).on('refresh', () =>
      location.reload()
    )
})

export default {}