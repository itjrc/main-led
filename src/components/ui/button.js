// Shadcn UI Button Component (ES5/jQuery adaptation)
class Button {
    constructor(element, options = {}) {
        this.element = element;
        this.options = {
            variant: 'default',
            size: 'default',
            disabled: false,
            ...options
        };
        this.init();
    }

    init() {
        this.element.classList.add('btn');
        this.applyVariant();
        this.applySize();
        
        if (this.options.disabled) {
            this.element.disabled = true;
            this.element.classList.add('btn-disabled');
        }
    }

    applyVariant() {
        const variants = {
            default: 'btn-primary',
            destructive: 'btn-danger',
            outline: 'btn-outline',
            secondary: 'btn-secondary',
            ghost: 'btn-ghost',
            link: 'btn-link'
        };
        
        const variantClass = variants[this.options.variant] || variants.default;
        this.element.classList.add(variantClass);
    }

    applySize() {
        const sizes = {
            default: 'btn-default',
            sm: 'btn-sm',
            lg: 'btn-lg',
            icon: 'btn-icon'
        };
        
        const sizeClass = sizes[this.options.size] || sizes.default;
        this.element.classList.add(sizeClass);
    }

    setLoading(loading) {
        if (loading) {
            this.element.disabled = true;
            this.element.classList.add('btn-loading');
            const spinner = document.createElement('span');
            spinner.className = 'btn-spinner';
            spinner.innerHTML = '⟳';
            this.element.prepend(spinner);
        } else {
            this.element.disabled = this.options.disabled;
            this.element.classList.remove('btn-loading');
            const spinner = this.element.querySelector('.btn-spinner');
            if (spinner) spinner.remove();
        }
    }

    static create(selector, options) {
        const elements = document.querySelectorAll(selector);
        elements.forEach(element => new Button(element, options));
    }
}

// Export for use
window.Button = Button;