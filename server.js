// Centralized error handling middleware
function errorHandler(err, req, res, next) {
    const timestamp = new Date().toISOString();
    const errorId = crypto.randomBytes(16).toString('hex');
    
    // Detailed error logging
    const errorContext = {
        error: err.message,
        stack: err.stack,
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.get('User-Agent'),
        method: req.method,
        path: req.path,
        body: req.method !== 'GET' ? JSON.stringify(req.body, null, 2) : undefined,
        params: req.params,
        query: req.query,
        timestamp
    };
    
    console.error(`[${timestamp}] [ERROR ${errorId}] ${req.method} ${req.path}`, errorContext);
    
    // Handle specific error types
    if (err.name === 'ValidationError') {
        return res.status(400).json({
            success: false,
            error: 'Validation Error',
            message: err.message,
            errorId
        });
    }
    
    if (err.name === 'UnauthorizedError') {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized',
            message: 'Invalid authentication credentials',
            errorId
        });
    }
    
    if (err.status === 404) {
        return res.status(404).json({
            success: false,
            error: 'Not Found',
            message: `Endpoint ${req.method} ${req.path} not found`,
            errorId
        });
    }
    
    // Handle axios/network errors
    if (err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') {
        return res.status(503).json({
            success: false,
            error: 'Service Unavailable',
            message: 'External service temporarily unavailable',
            errorId
        });
    }
    
    // Generic server error
    const isDevelopment = process.env.NODE_ENV === 'development';
    const errorResponse = {
        success: false,
        error: isDevelopment ? 'Internal Server Error' : 'Service Unavailable',
        message: isDevelopment ? err.message : 'An unexpected error occurred',
        errorId
    };
    
    if (isDevelopment) {
        errorResponse.stack = err.stack;
        errorResponse.details = {
            path: req.path,
            method: req.method,
            ip: req.ip || req.connection.remoteAddress,
            timestamp
        };
    }
    
    res.status(500).json(errorResponse);
}

// Request validation middleware
function validateRequest(req, res, next) {
    try {
        // Validate request body size
        const contentLength = JSON.stringify(req.body).length;
        if (contentLength > 100 * 1024) { // 100KB
            return res.status(413).json({
                success: false,
                error: 'Payload Too Large',
                message: 'Request body exceeds maximum size limit'
            });
        }
        
        // Validate required headers for API routes
        if (req.path.startsWith('/api/')) {
            if (!req.headers['user-agent']) {
                return res.status(400).json({
                    success: false,
                    error: 'Bad Request',
                    message: 'User-Agent header required'
                });
            }
        }
        
        // Basic input sanitization
        if (req.body) {
            // Use Object.create(null) to prevent prototype pollution
            const sanitizedBody = {};
            for (const key in req.body) {
                if (typeof req.body[key] === 'string') {
                    // Basic SQL injection prevention characters
                    const sqlChars = [';', '--', '/*', '*/', 'xp_'];
                    const found = sqlChars.some(char => req.body[key].includes(char));
                    if (found) {
                        return res.status(400).json({
                            success: false,
                            error: 'Bad Request',
                            message: 'Invalid characters in request data'
                        });
                    }
                    // Store sanitized value
                    sanitizedBody[key] = req.body[key];
                }
            }
            // Replace body with sanitized version
            req.body = sanitizedBody;
        }
        
        next();
    } catch (validationError) {
        console.error('Request validation error:', validationError);
        return res.status(400).json({
            success: false,
            error: 'Validation Error',
            message: 'Invalid request format'
        });
    }
}

// Centralized error handling middleware
function errorHandler(err, req, res, next) {
    const timestamp = new Date().toISOString();
    const errorId = crypto.randomBytes(16).toString('hex');
    
    // Detailed error logging
    const errorContext = {
        error: err.message,
        stack: err.stack,
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.get('User-Agent'),
        method: req.method,
        path: req.path,
        body: req.method !== 'GET' ? JSON.stringify(req.body, null, 2) : undefined,
        params: req.params,
        query: req.query,
        timestamp
    };
    
    console.error(`[${timestamp}] [ERROR ${errorId}] ${req.method} ${req.path}`, errorContext);
    
    // Handle specific error types
    if (err.name === 'ValidationError') {
        return res.status(400).json({
            success: false,
            error: 'Validation Error',
            message: err.message,
            errorId
        });
    }
    
    if (err.name === 'UnauthorizedError') {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized',
            message: 'Invalid authentication credentials',
            errorId
        });
    }
    
    if (err.status === 404) {
        return res.status(404).json({
            success: false,
            error: 'Not Found',
            message: `Endpoint ${req.method} ${req.path} not found`,
            errorId
        });
    }
    
    // Handle axios/network errors
    if (err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET') {
        return res.status(503).json({
            success: false,
            error: 'Service Unavailable',
            message: 'External service temporarily unavailable',
            errorId
        });
    }
    
    // Generic server error
    const isDevelopment = process.env.NODE_ENV === 'development';
    const errorResponse = {
        success: false,
        error: isDevelopment ? 'Internal Server Error' : 'Service Unavailable',
        message: isDevelopment ? err.message : 'An unexpected error occurred',
        errorId
    };
    
    if (isDevelopment) {
        errorResponse.stack = err.stack;
        errorResponse.details = {
            path: req.path,
            method: req.method,
            ip: req.ip || req.connection.remoteAddress,
            timestamp
        };
    }
    
    res.status(500).json(errorResponse);
}

// Request validation middleware
function validateRequest(req, res, next) {
    try {
        // Validate request body size
        const contentLength = JSON.stringify(req.body).length;
        if (contentLength > 100 * 1024) { // 100KB
            return res.status(413).json({
                success: false,
                error: 'Payload Too Large',
                message: 'Request body exceeds maximum size limit'
            });
        }
        
        // Validate required headers for API routes
        if (req.path.startsWith('/api/')) {
            if (!req.headers['user-agent']) {
                return res.status(400).json({
                    success: false,
                    error: 'Bad Request',
                    message: 'User-Agent header required'
                });
            }
        }
        
        // Basic input sanitization
        if (req.body) {
            // Use Object.create(null) to prevent prototype pollution
            const sanitizedBody = {};
            for (const key in req.body) {
                if (typeof req.body[key] === 'string') {
                    // Basic SQL injection prevention characters
                    const sqlChars = [';', '--', '/*', '*/', 'xp_'];
                    const found = sqlChars.some(char => req.body[key].includes(char));
                    if (found) {
                        return res.status(400).json({
                            success: false,
                            error: 'Bad Request',
                            message: 'Invalid characters in request data'
                        });
                    }
                    // Store sanitized value
                    sanitizedBody[key] = req.body[key];
                }
            }
            // Replace body with sanitized version
            req.body = sanitizedBody;
        }
        
        next();
    } catch (validationError) {
        console.error('Request validation error:', validationError);
        return res.status(400).json({
            success: false,
            error: 'Validation Error',
            message: 'Invalid request format'
        });
    }
}

// Enhanced security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self';");
    next();
});

// Apply request validation middleware
app.use(validateRequest);

// Apply error handling middleware
app.use(errorHandler);

// Enhanced security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self';");
    next();
});

// Apply request validation middleware
app.use(validateRequest);

// Apply error handling middleware
app.use(errorHandler);